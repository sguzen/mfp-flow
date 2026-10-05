import { bucketOf } from "./price";
import type { MinuteFP, Trade } from "./types";

export const MINUTE = 60_000;

export function minuteOf(t: number): number {
  return Math.floor(t / MINUTE) * MINUTE;
}

/**
 * Accumulates live trades into per-minute footprints at the finest row size,
 * deduplicating by tradeId (the stream replays retained trades on every
 * (re)subscribe and does not guarantee exactly-once delivery).
 *
 * Dedupe state is kept per minute for a bounded window so memory stays flat;
 * a trade older than the window is accepted only if its minute is unknown.
 */
export class FootprintBook {
  readonly fine: number;
  readonly minutes = new Map<number, MinuteFP>();
  private seen = new Map<number, Set<string>>();
  private latestMinute = 0;
  /** minutes of dedupe history to keep */
  readonly dedupeWindowMin: number;
  dupes = 0;
  accepted = 0;

  constructor(fineUnits: number, dedupeWindowMin = 90) {
    if (!(fineUnits > 0) || !Number.isInteger(fineUnits)) throw new Error("fine row size must be a positive integer number of units");
    this.fine = fineUnits;
    this.dedupeWindowMin = dedupeWindowMin;
  }

  /** Returns true if the trade was new and applied. */
  add(tr: Trade): boolean {
    const m = minuteOf(tr.t);
    let ids = this.seen.get(m);
    if (ids?.has(tr.id)) {
      this.dupes++;
      return false;
    }
    if (!ids) {
      if (this.latestMinute && m < this.latestMinute - this.dedupeWindowMin * MINUTE && this.minutes.has(m)) {
        // Too old to dedupe reliably and the minute already has data: drop rather than risk double counting.
        this.dupes++;
        return false;
      }
      ids = new Set();
      this.seen.set(m, ids);
    }
    ids.add(tr.id);
    if (m > this.latestMinute) {
      this.latestMinute = m;
      this.prune();
    }
    this.apply(m, tr);
    this.accepted++;
    return true;
  }

  private apply(m: number, tr: Trade) {
    let fp = this.minutes.get(m);
    if (!fp) {
      fp = { t: m, o: tr.px, h: tr.px, l: tr.px, c: tr.px, buy: 0, sell: 0, n: 0, firstT: tr.t, lastT: tr.t, cells: new Map() };
      this.minutes.set(m, fp);
    }
    // Trades can arrive slightly out of order: open/close follow exchange time.
    if (tr.t < fp.firstT) {
      fp.firstT = tr.t;
      fp.o = tr.px;
    }
    if (tr.t >= fp.lastT) {
      fp.lastT = tr.t;
      fp.c = tr.px;
    }
    if (tr.px > fp.h) fp.h = tr.px;
    if (tr.px < fp.l) fp.l = tr.px;
    fp.n++;
    const k = bucketOf(tr.px, this.fine);
    let cell = fp.cells.get(k);
    if (!cell) {
      cell = [0, 0];
      fp.cells.set(k, cell);
    }
    if (tr.side === 1) {
      cell[0] += tr.sz;
      fp.buy += tr.sz;
    } else {
      cell[1] += tr.sz;
      fp.sell += tr.sz;
    }
  }

  private prune() {
    const cutoff = this.latestMinute - this.dedupeWindowMin * MINUTE;
    for (const k of this.seen.keys()) if (k < cutoff) this.seen.delete(k);
  }

  /** Insert a persisted minute (from IndexedDB). Does not override a minute already built live. */
  restore(fp: MinuteFP): void {
    if (!this.minutes.has(fp.t)) this.minutes.set(fp.t, fp);
  }
}

/**
 * Real-trade coverage: time intervals during which we are confident every
 * trade was received (subscription live, plus the retained replay it began with).
 */
export interface Segment {
  from: number;
  to: number;
  open: boolean;
}

export class Coverage {
  segments: Segment[] = [];
  private cur: Segment | null = null;
  private lastTradeT = 0;

  /** Call when a trades subscription is (re)established. */
  begin(): void {
    this.cur = null;
  }

  /** Every received trade (new or duplicate) extends the open segment. */
  note(t: number, now: number): void {
    if (!this.cur) {
      // A replay that reaches back into the previous segment makes coverage continuous.
      const prev = this.segments[this.segments.length - 1];
      if (prev && !prev.open && t <= prev.to) {
        prev.open = true;
        prev.to = Math.max(prev.to, now);
        this.cur = prev;
      } else {
        this.cur = { from: t, to: now, open: true };
        this.segments.push(this.cur);
      }
    }
    if (t < this.cur.from) this.cur.from = t;
    if (now > this.cur.to) this.cur.to = now;
    if (t > this.lastTradeT) this.lastTradeT = t;
  }

  /** Mark the start of a live session even before the first trade (quiet markets). */
  touch(now: number): void {
    if (this.cur && now > this.cur.to) this.cur.to = now;
  }

  /** Call on disconnect. */
  end(at: number): void {
    if (this.cur) {
      // We were connected (and receiving every trade) until the disconnect.
      this.cur.open = false;
      this.cur.to = Math.max(this.cur.to, at);
    }
    this.cur = null;
  }

  /** Is [from, to) fully covered by real trades? An open segment covers up to now. */
  covers(from: number, to: number): boolean {
    for (const s of this.segments) {
      if (s.from <= from && (s.open || s.to >= to)) return true;
    }
    return false;
  }

  isMinuteReal(m: number): boolean {
    return this.covers(m, m + MINUTE);
  }

  /** earliest covered time, or null */
  earliest(): number | null {
    return this.segments.length ? Math.min(...this.segments.map((s) => s.from)) : null;
  }

  restore(segs: Segment[]): void {
    for (const s of segs) this.segments.push({ from: s.from, to: s.to, open: false });
    this.segments.sort((a, b) => a.from - b.from);
  }
}
