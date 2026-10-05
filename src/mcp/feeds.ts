/**
 * One socket, a few cached feeds.
 *
 * Loading a market's history is the expensive part (several thousand candles,
 * paged), so a feed is kept warm for a couple of minutes after the last
 * question and reused. The stream itself has a history-concurrency limit, so no
 * more than two markets load at once; the rest queue.
 */
import type { SessionMode } from "../analytics/session";
import { MarketFeed } from "../data/feed";
import type { Market } from "../data/markets";
import { MarketStream } from "../data/stream";

const IDLE_MS = 120_000;
const MAX_CONCURRENT_HISTORY = 2;

interface Entry {
  feed: MarketFeed;
  started: Promise<void>;
  days: number;
  last: number;
}

export class FeedPool {
  private stream = new MarketStream();
  private entries = new Map<string, Entry>();
  private active = 0;
  private waiting: (() => void)[] = [];
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private connected = false;

  /** Run `fn` with at most MAX_CONCURRENT_HISTORY others in flight. */
  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_CONCURRENT_HISTORY) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  private key(m: Market, session: SessionMode) {
    return `${m.market_id}|${session}`;
  }

  /**
   * A started feed with at least `days` of history. A cached feed with less
   * depth than asked for is replaced, since its history was never fetched.
   */
  async get(market: Market, session: SessionMode, days: number): Promise<MarketFeed> {
    const k = this.key(market, session);
    const hit = this.entries.get(k);
    if (hit && hit.days >= days) {
      hit.last = Date.now();
      await hit.started;
      return hit.feed;
    }
    if (hit) {
      hit.feed.stop();
      this.entries.delete(k);
    }
    if (!this.connected) {
      this.stream.connect();
      this.connected = true;
      this.sweeper ??= setInterval(() => this.sweep(), 30_000);
      // never hold the process open just to keep the cache tidy
      this.sweeper.unref?.();
    }
    const feed = new MarketFeed(this.stream, market, {
      priorSessions: Math.max(1, days - 1),
      session: { mode: session },
    });
    const entry: Entry = { feed, days, last: Date.now(), started: this.withSlot(() => feed.start()) };
    this.entries.set(k, entry);
    try {
      await entry.started;
    } catch (e) {
      this.entries.delete(k);
      feed.stop();
      throw e;
    }
    entry.last = Date.now();
    return feed;
  }

  private sweep() {
    const cut = Date.now() - IDLE_MS;
    for (const [k, e] of this.entries) {
      if (e.last < cut) {
        e.feed.stop();
        this.entries.delete(k);
      }
    }
  }

  dispose() {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    for (const e of this.entries.values()) e.feed.stop();
    this.entries.clear();
    this.stream.close();
    this.connected = false;
  }
}
