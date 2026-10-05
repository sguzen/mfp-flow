/**
 * MarketFeed: all live + historical data for one market, DOM-free so the same
 * code runs in the browser and in the Node smoke test.
 *
 * Start-up sequence
 *  1. subscribe `trades` (buffered) and `marketStats` immediately
 *  2. fetch the latest 1m candles → infer the market tick and a reference price
 *     → fix the fine storage row size (it can't change once trades are stored)
 *  3. restore persisted minutes (optional), flush buffered trades
 *  4. subscribe live 1m `candles`, then page older 1m history backwards
 *     (`candles.history` with `endTime`) until the requested sessions are loaded
 *
 * On reconnect the stream client resubscribes; the trade replay is deduped by
 * tradeId, and any gap not covered by the replay is filled from 1m candles.
 */
import { Coverage, FootprintBook, MINUTE, minuteOf, type Segment } from "../analytics/footprint";
import { normCandle, normTrade, type WireCandle, type WireTrade } from "../analytics/normalize";
import { chooseBuckets, inferTick, unitsFromNumber, type BucketChoice } from "../analytics/price";
import type { MinuteSource } from "../analytics/series";
import { recentSessionStarts, type SessionSpec } from "../analytics/session";
import type { Candle, MinuteFP } from "../analytics/types";
import type { Market } from "./markets";
import { MarketStream, RequestError, withRetry, type StreamStatus } from "./stream";

export interface Persistence {
  load(marketId: string, fine: number, since: number): Promise<{ minutes: MinuteFP[]; segments: Segment[] } | null>;
  save(marketId: string, fine: number, minutes: MinuteFP[], segments: Segment[]): Promise<boolean>;
}

export interface MarketStats {
  markPx: number | null;
  change24hPct: number | null;
  fundingRate: number | null;
  fundingIntervalHours: number | null;
  openInterestUsd: number | null;
  dayNtlVlm: number | null;
  time: number | null;
}

export type FeedChange = "ready" | "trades" | "candles" | "history" | "stats" | "status";

export interface HistoryInfo {
  state: "idle" | "loading" | "done" | "error";
  candles: number;
  earliest: number | null;
  wantedFrom: number;
  pages: number;
  message?: string;
  /** history before this time comes from 30-minute candles */
  coarseBefore?: number;
}

export interface FeedOptions {
  /** number of complete prior sessions to load besides the current one */
  priorSessions: number;
  session: SessionSpec;
  persist?: Persistence;
  onChange?: (kind: FeedChange) => void;
  log?: (...a: unknown[]) => void;
  /** max candles per history page (binance caps at 1500) */
  pageLimit?: number;
}

export class MarketFeed {
  readonly market: Market;
  readonly stream: MarketStream;
  book: FootprintBook | null = null;
  readonly coverage = new Coverage();
  readonly candles = new Map<number, Candle>();
  tick = 0;
  buckets: BucketChoice | null = null;
  lastPrice: number | null = null;
  lastTradeT = 0;
  stats: MarketStats = { markPx: null, change24hPct: null, fundingRate: null, fundingIntervalHours: null, openInterestUsd: null, dayNtlVlm: null, time: null };
  history: HistoryInfo;
  /** minutes changed since the consumer last drained them */
  readonly dirty = new Set<number>();
  /** set when a change requires a full rebuild (e.g. older history arrived) */
  structural = true;
  tradesSeen = 0;
  tradesReplayed = 0;
  ready = false;
  restoredMinutes = 0;
  error: string | null = null;

  private opts: FeedOptions;
  private unsubs: Array<() => void> = [];
  private pending: WireTrade[] = [];
  private persistDirty = new Set<number>();
  private persistTimer: ReturnType<typeof setInterval> | null = null;
  private touchTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private subscribedOnce = false;
  private lastState: StreamStatus["state"] | null = null;

  constructor(stream: MarketStream, market: Market, opts: FeedOptions) {
    this.stream = stream;
    this.market = market;
    this.opts = opts;
    this.history = { state: "idle", candles: 0, earliest: null, wantedFrom: this.wantedFrom(), pages: 0 };
  }

  private emit(k: FeedChange) {
    this.opts.onChange?.(k);
  }

  private log(...a: unknown[]) {
    this.opts.log?.(`[${this.market.coin}]`, ...a);
  }

  private wantedFrom(): number {
    return recentSessionStarts(Date.now(), this.opts.session, this.opts.priorSessions + 1)[0];
  }

  get filter() {
    return { symbols: [this.market.coin], providers: [this.market.provider] };
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.unsubs.push(
      this.stream.onStatus((s) => {
        if (this.lastState === "open" && s.state !== "open") this.coverage.end(s.lastDisconnectAt ?? Date.now());
        this.lastState = s.state;
        this.emit("status");
      }),
    );
    this.unsubs.push(
      this.stream.subscribe(
        { channel: "trades", payload: this.filter },
        {
          onSubscribed: () => {
            this.coverage.begin();
            if (this.subscribedOnce) this.backfillGap();
            this.subscribedOnce = true;
          },
          onEvents: (evs, replay) => this.onTrades(evs as WireTrade[], replay),
          onError: (e) => {
            this.error = `trades subscription rejected: ${JSON.stringify(e)}`;
            this.emit("status");
          },
        },
      ),
    );
    this.unsubs.push(
      this.stream.subscribe(
        { channel: "marketStats", payload: this.filter },
        { onEvents: (evs) => this.onStats(evs), onError: () => {} },
      ),
    );

    // 2. latest candles → tick + reference price
    this.history.state = "loading";
    let latest: Candle[] = [];
    try {
      latest = await this.fetchHistory({ limit: this.opts.pageLimit ?? 1500 });
    } catch (e) {
      this.history.message = `candles.history failed: ${(e as Error).message}`;
      this.log(this.history.message);
    }
    if (this.stopped) return;
    for (const c of latest) this.candles.set(c.t, c);
    if (!latest.length) await this.waitForTrades(8_000);
    if (this.stopped) return;
    this.initBook(latest);

    // 3. restore persisted real minutes
    if (this.opts.persist && this.book) {
      try {
        const r = await this.opts.persist.load(this.market.market_id, this.book.fine, this.history.wantedFrom);
        if (r) {
          for (const m of r.minutes) this.book.restore(m);
          this.coverage.restore(r.segments);
          this.restoredMinutes = r.minutes.length;
        }
      } catch {
        /* best effort */
      }
    }
    const buf = this.pending;
    this.pending = [];
    this.applyTrades(buf);
    this.ready = true;
    this.structural = true;
    this.emit("ready");

    // 4. live candles + older history
    this.unsubs.push(
      this.stream.subscribe(
        { channel: "candles", payload: { ...this.filter, intervals: ["1m"], historyLimit: 3 } },
        { onEvents: (evs) => this.onCandles(evs as WireCandle[]), onError: () => {} },
      ),
    );
    this.touchTimer = setInterval(() => this.coverage.touch(Date.now()), 1000);
    if (this.opts.persist) this.persistTimer = setInterval(() => void this.flushPersist(), 15_000);
    await this.loadOlder(latest);
  }

  stop(): void {
    this.stopped = true;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (this.persistTimer) clearInterval(this.persistTimer);
    if (this.touchTimer) clearInterval(this.touchTimer);
    this.persistTimer = this.touchTimer = null;
    void this.flushPersist();
  }

  private waitForTrades(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (this.pending.length >= 20 || Date.now() - t0 > ms || this.stopped) {
          clearInterval(iv);
          resolve();
        }
      }, 200);
    });
  }

  private initBook(latest: Candle[]) {
    const prices: number[] = [];
    for (const c of latest) prices.push(c.o, c.h, c.l, c.c);
    for (const w of this.pending) {
      const t = safeTrade(w);
      if (t) prices.push(t.px);
    }
    const tick = inferTick(prices);
    const ref = latest.length ? latest[latest.length - 1].c : prices.length ? prices[prices.length - 1] : unitsFromNumber(1);
    this.tick = tick;
    this.buckets = chooseBuckets(ref, tick);
    this.book = new FootprintBook(this.buckets.fineUnits);
    this.lastPrice = ref;
    this.log("tick", tick, "fine", this.buckets.fineUnits, "default row", this.buckets.defaultUnits);
  }

  private onTrades(evs: WireTrade[], replay: boolean) {
    if (replay) this.tradesReplayed += evs.length;
    if (!this.book) {
      for (const e of evs) if (this.pending.length < 200_000) this.pending.push(e);
      // coverage still starts now, so the replay window counts once the book exists
      const now = Date.now();
      for (const e of evs) if (typeof e?.time === "number") this.coverage.note(e.time, now);
      return;
    }
    this.applyTrades(evs);
  }

  private applyTrades(evs: WireTrade[]) {
    const book = this.book!;
    const now = Date.now();
    let changed = false;
    for (const e of evs) {
      const t = safeTrade(e);
      if (!t) continue;
      this.tradesSeen++;
      this.coverage.note(t.t, now);
      if (book.add(t)) {
        const m = minuteOf(t.t);
        this.dirty.add(m);
        this.persistDirty.add(m);
        changed = true;
        if (t.t >= this.lastTradeT) {
          this.lastTradeT = t.t;
          this.lastPrice = t.px;
        }
      }
    }
    if (changed) this.emit("trades");
  }

  private onCandles(evs: WireCandle[]) {
    let changed = false;
    for (const w of evs) {
      if (w.interval !== "1m") continue;
      const c = safeCandle(w);
      if (!c) continue;
      this.candles.set(c.t, c);
      this.dirty.add(c.t);
      changed = true;
      if (this.lastTradeT === 0 || c.t >= minuteOf(this.lastTradeT)) this.lastPrice = c.c;
    }
    if (changed) this.emit("candles");
  }

  private onStats(evs: any[]) {
    for (const e of evs) {
      if (!e || e.type !== "marketStats") continue;
      // patches: omitted = keep, null = clear
      for (const k of ["markPx", "change24hPct", "fundingRate", "fundingIntervalHours", "openInterestUsd", "dayNtlVlm", "time"] as const) {
        if (k in e) (this.stats as any)[k] = e[k];
      }
    }
    this.emit("stats");
  }

  private async fetchHistory(p: { limit: number; startTime?: number; endTime?: number }, interval = "1m"): Promise<Candle[]> {
    const res = await withRetry(() =>
      this.stream.request<WireCandle[]>("candles.history", {
        provider: this.market.provider,
        symbol: this.market.coin,
        interval,
        ...p,
      }),
    );
    if (!Array.isArray(res)) return [];
    const out: Candle[] = [];
    for (const w of res) {
      const c = safeCandle(w);
      if (c) out.push(c);
    }
    return out.sort((a, b) => a.t - b.t);
  }

  /** Page backwards until the wanted session range is loaded or the provider runs out. */
  private async loadOlder(latest: Candle[]) {
    const wanted = this.history.wantedFrom;
    let earliest = latest.length ? latest[0].t : Date.now();
    this.history.earliest = latest.length ? earliest : null;
    this.history.candles = this.candles.size;
    this.history.pages = latest.length ? 1 : 0;
    this.structural = true;
    this.emit("history");
    const limit = this.opts.pageLimit ?? 1500;
    try {
      for (let guard = 0; guard < 20 && earliest > wanted && !this.stopped; guard++) {
        const page = await this.fetchHistory({ endTime: earliest - 1, limit });
        if (this.stopped) return;
        const older = page.filter((c) => c.t < earliest);
        if (!older.length) {
          this.history.message = `provider history ends at ${new Date(earliest).toISOString().slice(0, 16)}Z`;
          break;
        }
        for (const c of older) if (!this.candles.has(c.t)) this.candles.set(c.t, c);
        earliest = older[0].t;
        this.history.earliest = earliest;
        this.history.candles = this.candles.size;
        this.history.pages++;
        this.structural = true;
        this.emit("history");
      }
      // Some venues keep only ~5,000 one-minute candles (Hyperliquid: ~3.5 days).
      // Fill older sessions from 30-minute candles: exact for 30m bars and TPO
      // periods, an approximation for volume profiles like the rest of history.
      if (earliest > wanted && !this.stopped) {
        const P30 = 30 * 60_000;
        const limit30 = Math.min(1500, Math.ceil((earliest - wanted) / P30) + 2);
        const coarse = await this.fetchHistory({ endTime: earliest - 1, limit: limit30 }, "30m");
        let added = 0;
        for (const c of coarse) {
          if (c.t + P30 > earliest || this.candles.has(c.t)) continue;
          this.candles.set(c.t, { ...c, dur: P30 });
          added++;
        }
        if (added) {
          this.history.coarseBefore = earliest;
          this.history.earliest = Math.min(earliest, ...coarse.filter((c) => c.t + P30 <= earliest).map((c) => c.t));
          this.history.candles = this.candles.size;
          this.history.pages++;
          this.history.message = `1m history ends at ${new Date(earliest).toISOString().slice(0, 16)}Z; older sessions use 30m candles`;
          this.structural = true;
          this.emit("history");
        }
      }
      this.history.state = "done";
    } catch (e) {
      this.history.state = "error";
      this.history.message = `history paging stopped: ${e instanceof RequestError ? e.message : String(e)}`;
    }
    this.structural = true;
    this.emit("history");
  }

  /** After a reconnect: refill any minutes the trade replay didn't cover. */
  private async backfillGap() {
    const from = (this.stream.status.lastDisconnectAt ?? Date.now()) - 2 * MINUTE;
    try {
      const page = await this.fetchHistory({ startTime: minuteOf(from), limit: 1500 });
      for (const c of page) {
        this.candles.set(c.t, c);
        this.dirty.add(c.t);
      }
      this.emit("candles");
    } catch (e) {
      this.log("gap backfill failed", (e as Error).message);
    }
  }

  async flushPersist(): Promise<void> {
    if (!this.opts.persist || !this.book || this.persistDirty.size === 0) return;
    const keys = [...this.persistDirty];
    this.persistDirty.clear();
    const mins = keys.map((k) => this.book!.minutes.get(k)).filter((x): x is MinuteFP => !!x);
    await this.opts.persist.save(this.market.market_id, this.book.fine, mins, this.coverage.segments);
  }

  source(): MinuteSource | null {
    if (!this.book) return null;
    const cov = this.coverage;
    return {
      minutes: this.book.minutes,
      candles: this.candles,
      fine: this.book.fine,
      tick: this.tick || this.book.fine,
      isReal: (m) => cov.isMinuteReal(m),
    };
  }

  /** Earliest time real trade data is available (null = none yet). */
  realSince(): number | null {
    return this.coverage.earliest();
  }
}

function safeTrade(w: WireTrade) {
  try {
    return normTrade(w);
  } catch {
    return null;
  }
}

function safeCandle(w: WireCandle) {
  try {
    return normCandle(w);
  } catch {
    return null;
  }
}
