/**
 * SQLite store for the recorder, behind the app's own `Persistence` interface
 * so MarketFeed drives it unchanged — the recorder is the same feed the browser
 * runs, writing to a file instead of IndexedDB.
 *
 * Uses node:sqlite, built into Node 22, so the service has no native build step.
 *
 * `fine` is the row size the cells are indexed at. It is fixed per market once
 * trades are stored, so rows recorded at a different size are never mixed in:
 * doing so would put volume at the wrong prices.
 */
import { DatabaseSync } from "node:sqlite";
import type { Segment } from "../src/analytics/footprint.js";
import type { MinuteFP } from "../src/analytics/types.js";
import type { Persistence } from "../src/data/feed.js";
import { decodeMinute, encodeMinute } from "../src/data/recorder-wire.js";

export const DAY = 86_400_000;

export class RecorderStore implements Persistence {
  private db: DatabaseSync;

  constructor(path: string, readonly retentionDays = 14) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS minutes (
        market TEXT NOT NULL,
        t      INTEGER NOT NULL,
        fine   INTEGER NOT NULL,
        o REAL, h REAL, l REAL, c REAL,
        buy REAL, sell REAL, n INTEGER,
        firstT INTEGER, lastT INTEGER,
        cells  TEXT NOT NULL,
        PRIMARY KEY (market, t)
      );
      CREATE INDEX IF NOT EXISTS minutes_by_time ON minutes (market, t);
      CREATE TABLE IF NOT EXISTS segments (
        market TEXT NOT NULL,
        from_t INTEGER NOT NULL,
        to_t   INTEGER NOT NULL,
        PRIMARY KEY (market, from_t)
      );
    `);
  }

  /** The row size this market's stored cells are indexed at, if any. */
  fineFor(market: string): number | null {
    const r = this.db.prepare("SELECT fine FROM minutes WHERE market = ? ORDER BY t DESC LIMIT 1").get(market) as
      | { fine: number }
      | undefined;
    return r?.fine ?? null;
  }

  async save(market: string, fine: number, minutes: MinuteFP[], segments: Segment[]): Promise<boolean> {
    const stored = this.fineFor(market);
    if (stored != null && stored !== fine) {
      console.error(`[${market}] row size changed ${stored} -> ${fine}; refusing to mix. Clear the market to re-record.`);
      return false;
    }
    const ins = this.db.prepare(`
      INSERT INTO minutes (market, t, fine, o, h, l, c, buy, sell, n, firstT, lastT, cells)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(market, t) DO UPDATE SET
        fine=excluded.fine, o=excluded.o, h=excluded.h, l=excluded.l, c=excluded.c,
        buy=excluded.buy, sell=excluded.sell, n=excluded.n,
        firstT=excluded.firstT, lastT=excluded.lastT, cells=excluded.cells
    `);
    const seg = this.db.prepare("INSERT INTO segments (market, from_t, to_t) VALUES (?,?,?) ON CONFLICT(market, from_t) DO UPDATE SET to_t=excluded.to_t");
    this.db.exec("BEGIN");
    try {
      for (const m of minutes) {
        const w = encodeMinute(m);
        ins.run(market, w.t, fine, w.o, w.h, w.l, w.c, w.buy, w.sell, w.n, w.firstT, w.lastT, JSON.stringify(w.cells));
      }
      for (const s of segments) seg.run(market, s.from, s.to);
      this.db.exec("COMMIT");
      return true;
    } catch (e) {
      this.db.exec("ROLLBACK");
      console.error(`[${market}] save failed:`, (e as Error).message);
      return false;
    }
  }

  async load(market: string, fine: number, since: number): Promise<{ minutes: MinuteFP[]; segments: Segment[] } | null> {
    const stored = this.fineFor(market);
    if (stored != null && stored !== fine) return null;
    return this.read(market, since, Number.MAX_SAFE_INTEGER);
  }

  /** Minutes in [from, to], with the coverage segments that overlap them. */
  read(market: string, from: number, to: number): { minutes: MinuteFP[]; segments: Segment[]; fine: number | null } {
    const rows = this.db
      .prepare("SELECT * FROM minutes WHERE market = ? AND t >= ? AND t <= ? ORDER BY t")
      .all(market, from, to) as Record<string, unknown>[];
    const minutes: MinuteFP[] = [];
    for (const r of rows) {
      const m = decodeMinute({ ...r, cells: JSON.parse(String(r.cells)) as number[] });
      if (m) minutes.push(m);
    }
    const segs = this.db
      .prepare("SELECT from_t, to_t FROM segments WHERE market = ? AND to_t >= ? AND from_t <= ? ORDER BY from_t")
      .all(market, from, to) as { from_t: number; to_t: number }[];
    return {
      minutes,
      segments: segs.map((s) => ({ from: s.from_t, to: s.to_t, open: false })),
      fine: this.fineFor(market),
    };
  }

  /** Drop anything past the retention window. */
  prune(now = Date.now()): number {
    const cut = now - this.retentionDays * DAY;
    const a = this.db.prepare("DELETE FROM minutes WHERE t < ?").run(cut);
    this.db.prepare("DELETE FROM segments WHERE to_t < ?").run(cut);
    return Number(a.changes ?? 0);
  }

  stats(): { market: string; minutes: number; earliest: number; latest: number }[] {
    return this.db
      .prepare("SELECT market, COUNT(*) AS minutes, MIN(t) AS earliest, MAX(t) AS latest FROM minutes GROUP BY market ORDER BY market")
      .all() as { market: string; minutes: number; earliest: number; latest: number }[];
  }

  close() {
    this.db.close();
  }
}
