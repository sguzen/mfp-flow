/**
 * Auction-market context detectors. These describe structure; they are not
 * trade signals and carry no claim of predictive value.
 */
import type { Profile, ValueArea } from "./profile";
import type { Bar } from "./types";

export interface RowRange {
  /** lowest row */
  from: number;
  /** highest row */
  to: number;
}

/**
 * Single prints / low-volume nodes: contiguous runs of rows *inside* the
 * profile range (not at its extremes) whose volume is below `frac` × the
 * profile's mean non-zero row volume. With live trades a true single print is
 * a row traded in only one bar; with candle-estimated volume we can only see
 * thin rows, so both are reported as LVN runs.
 */
export function lowVolumeNodes(p: Profile, frac = 0.15, minRows = 1): RowRange[] {
  const n = p.hi - p.lo + 1;
  if (n < 5) return [];
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < n; i++)
    if (p.vol[i] > 0) {
      sum += p.vol[i];
      cnt++;
    }
  if (!cnt) return [];
  const thr = (sum / cnt) * frac;
  const out: RowRange[] = [];
  let start = -1;
  // skip the extreme rows: thin tails at the edges are excess, not LVNs
  for (let i = 1; i < n - 1; i++) {
    const thin = p.vol[i] < thr;
    if (thin && start < 0) start = i;
    if ((!thin || i === n - 2) && start >= 0) {
      const end = thin ? i : i - 1;
      if (end - start + 1 >= minRows) out.push({ from: p.lo + start, to: p.lo + end });
      start = -1;
    }
  }
  return out;
}

/**
 * Single prints in the strict sense: rows touched by exactly one bar of the
 * session (using bar high/low ranges at the given row size), excluding the
 * session's extreme rows. Contiguous rows are merged.
 */
export function singlePrints(bars: Bar[], rowUnits: number, minRun = 2): RowRange[] {
  if (bars.length < 3) return [];
  const touches = new Map<number, number>();
  let lo = Infinity;
  let hi = -Infinity;
  for (const b of bars) {
    const r0 = Math.floor(b.l / rowUnits);
    const r1 = Math.floor(b.h / rowUnits);
    if (r0 < lo) lo = r0;
    if (r1 > hi) hi = r1;
    for (let r = r0; r <= r1; r++) touches.set(r, (touches.get(r) ?? 0) + 1);
  }
  const out: RowRange[] = [];
  let start: number | null = null;
  for (let r = lo + 1; r <= hi; r++) {
    const single = r < hi && touches.get(r) === 1;
    if (single && start === null) start = r;
    if (!single && start !== null) {
      if (r - start >= minRun) out.push({ from: start, to: r - 1 });
      start = null;
    }
  }
  return out;
}

export interface PoorExtreme {
  kind: "poor-high" | "poor-low";
  row: number;
  /** volume of the extreme row relative to the profile's mean non-zero row */
  rel: number;
  /** number of thin rows (tail) beyond the first "substantial" row */
  tailRows: number;
}

/**
 * Poor high / low: the auction ended without excess. We look at the top
 * (bottom) `edgeRows` rows of the profile: if the extreme row itself already
 * carries substantial volume (>= `substantial` × mean row volume) and there
 * is no tail of at least `minTail` thin rows, the extreme is flagged.
 */
export function poorExtremes(p: Profile, opts: { substantial?: number; minTail?: number } = {}): PoorExtreme[] {
  const substantial = opts.substantial ?? 0.5;
  const minTail = opts.minTail ?? 2;
  const n = p.hi - p.lo + 1;
  if (n < 6) return [];
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < n; i++)
    if (p.vol[i] > 0) {
      sum += p.vol[i];
      cnt++;
    }
  const mean = sum / Math.max(1, cnt);
  const thr = mean * substantial;
  const out: PoorExtreme[] = [];
  // top
  let t = 0;
  while (t < n && p.vol[n - 1 - t] < thr) t++;
  if (t < minTail) out.push({ kind: "poor-high", row: p.hi, rel: p.vol[n - 1] / mean, tailRows: t });
  // bottom
  let b = 0;
  while (b < n && p.vol[b] < thr) b++;
  if (b < minTail) out.push({ kind: "poor-low", row: p.lo, rel: p.vol[0] / mean, tailRows: b });
  return out;
}

export interface Reference {
  label: string;
  /** price units */
  price: number;
  /** +1 if it's an upper reference (VAH / high), -1 lower (VAL / low) */
  dir: 1 | -1;
}

export interface FailedAuction {
  ref: Reference;
  /** index of the bar that first traded beyond the reference */
  breakIdx: number;
  /** index of the bar that closed back inside */
  backIdx: number;
  /** furthest price beyond the reference (units) */
  extreme: number;
  /** delta accumulated while price was beyond the reference */
  excursionDelta: number;
  /** delta source: "real" if every bar in the excursion was real, otherwise "estimated" */
  deltaQuality: "real" | "estimated" | "mixed";
  /** did the delta support the breakout direction? */
  supported: boolean;
}

/**
 * Failed auction vs prior-session references: price trades beyond an upper
 * (lower) reference and later CLOSES a bar back inside it. Only the latest
 * excursion per reference is reported. `delta(i)` returns the bar delta to use.
 */
export function failedAuctions(
  bars: Bar[],
  i0: number,
  i1: number,
  refs: Reference[],
  delta: (i: number) => number,
  isReal: (i: number) => boolean,
): FailedAuction[] {
  const out: FailedAuction[] = [];
  for (const ref of refs) {
    let breakIdx = -1;
    let extreme = ref.price;
    let ex = 0;
    let real = 0;
    let est = 0;
    let found: FailedAuction | null = null;
    for (let i = i0; i <= i1; i++) {
      const b = bars[i];
      const beyond = ref.dir === 1 ? b.h > ref.price : b.l < ref.price;
      const closedInside = ref.dir === 1 ? b.c < ref.price : b.c > ref.price;
      if (breakIdx < 0) {
        if (beyond) {
          breakIdx = i;
          extreme = ref.dir === 1 ? b.h : b.l;
          ex = delta(i);
          real = isReal(i) ? 1 : 0;
          est = isReal(i) ? 0 : 1;
          if (closedInside) {
            // one-bar probe and back
            found = mk(ref, breakIdx, i, extreme, ex, real, est);
            breakIdx = -1;
          }
        }
      } else {
        if (ref.dir === 1 ? b.h > extreme : b.l < extreme) extreme = ref.dir === 1 ? b.h : b.l;
        ex += delta(i);
        if (isReal(i)) real++;
        else est++;
        if (closedInside) {
          found = mk(ref, breakIdx, i, extreme, ex, real, est);
          breakIdx = -1;
        }
      }
    }
    if (found) out.push(found);
  }
  return out;
}

function mk(ref: Reference, breakIdx: number, backIdx: number, extreme: number, ex: number, real: number, est: number): FailedAuction {
  return {
    ref,
    breakIdx,
    backIdx,
    extreme,
    excursionDelta: ex,
    deltaQuality: est === 0 ? "real" : real === 0 ? "estimated" : "mixed",
    supported: ref.dir === 1 ? ex > 0 : ex < 0,
  };
}

export interface NakedPoc {
  session: number;
  /** POC price (units, row low) */
  row: number;
}

/**
 * Naked (virgin) POCs: POCs of earlier sessions that no later bar has traded
 * through. `sessions` must be in chronological order; rows are in row units.
 */
export function nakedPocs(
  sessions: { start: number; poc: number | null; i1: number }[],
  bars: Bar[],
  rowUnits: number,
): NakedPoc[] {
  const out: NakedPoc[] = [];
  for (let s = 0; s < sessions.length - 1; s++) {
    const poc = sessions[s].poc;
    if (poc === null) continue;
    const pxLo = poc * rowUnits;
    const pxHi = pxLo + rowUnits;
    let touched = false;
    for (let i = sessions[s].i1 + 1; i < bars.length && !touched; i++) {
      const b = bars[i];
      if (b.l < pxHi && b.h >= pxLo) touched = true;
    }
    if (!touched) out.push({ session: sessions[s].start, row: poc });
  }
  return out;
}

export interface Divergence {
  /** bar index where the divergence is observed */
  idx: number;
  kind: "bearish" | "bullish";
  /** index of the earlier extreme it is compared with */
  refIdx: number;
}

/**
 * Price-vs-CVD divergence over a lookback (context only):
 *  - bearish: bar makes a higher high than every bar in the prior `lookback`
 *    bars while CVD at that bar is below the CVD at the bar of the prior high.
 *  - bullish: mirror for lows.
 */
export function cvdDivergences(bars: Bar[], cvd: number[], lookback = 20, from = 0): Divergence[] {
  const out: Divergence[] = [];
  for (let i = Math.max(from, 1); i < bars.length; i++) {
    const a = Math.max(0, i - lookback);
    if (i - a < 3) continue;
    let hiIdx = a;
    let loIdx = a;
    for (let k = a; k < i; k++) {
      if (bars[k].h > bars[hiIdx].h) hiIdx = k;
      if (bars[k].l < bars[loIdx].l) loIdx = k;
    }
    if (bars[i].h > bars[hiIdx].h && cvd[i] < cvd[hiIdx]) out.push({ idx: i, kind: "bearish", refIdx: hiIdx });
    else if (bars[i].l < bars[loIdx].l && cvd[i] > cvd[loIdx]) out.push({ idx: i, kind: "bullish", refIdx: loIdx });
  }
  return out;
}

/** VA references of a session for failed-auction checks. */
export function sessionRefs(va: ValueArea | null, high: number, low: number, rowUnits: number, label: string): Reference[] {
  const refs: Reference[] = [];
  if (va) {
    refs.push({ label: `${label} VAH`, price: (va.vah + 1) * rowUnits, dir: 1 });
    refs.push({ label: `${label} VAL`, price: va.val * rowUnits, dir: -1 });
  }
  if (Number.isFinite(high)) refs.push({ label: `${label} high`, price: high, dir: 1 });
  if (Number.isFinite(low)) refs.push({ label: `${label} low`, price: low, dir: -1 });
  return refs;
}
