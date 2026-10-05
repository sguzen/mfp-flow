/**
 * IndexedDB persistence of recorded live trades, aggregated per minute at
 * the fine row size, plus the real-trade coverage segments. Everything is
 * best-effort: any failure (private window, blocked storage, quota) leaves
 * the app fully functional without persistence.
 */
import type { Segment } from "../analytics/footprint";
import type { MinuteFP } from "../analytics/types";

const DB_NAME = "mfp-flow";
const DB_VERSION = 1;
const MIN_STORE = "minutes";
const META_STORE = "meta";

interface MinuteRec {
  k: string; // `${marketId}|${minute}`
  m: string; // marketId
  t: number;
  fine: number;
  o: number;
  h: number;
  l: number;
  c: number;
  buy: number;
  sell: number;
  n: number;
  firstT: number;
  lastT: number;
  cells: number[]; // flat [row, buy, sell, row, buy, sell, ...]
}

interface MetaRec {
  m: string;
  fine: number;
  segments: Segment[];
  savedAt: number;
}

let dbp: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(MIN_STORE)) {
          const s = db.createObjectStore(MIN_STORE, { keyPath: "k" });
          s.createIndex("m_t", ["m", "t"]);
        }
        if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: "m" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbp;
}

function toRec(marketId: string, fine: number, fp: MinuteFP): MinuteRec {
  const cells: number[] = [];
  for (const [k, [b, s]] of fp.cells) cells.push(k, b, s);
  return {
    k: `${marketId}|${fp.t}`,
    m: marketId,
    t: fp.t,
    fine,
    o: fp.o,
    h: fp.h,
    l: fp.l,
    c: fp.c,
    buy: fp.buy,
    sell: fp.sell,
    n: fp.n,
    firstT: fp.firstT,
    lastT: fp.lastT,
    cells,
  };
}

function fromRec(r: MinuteRec): MinuteFP {
  const cells = new Map<number, [number, number]>();
  for (let i = 0; i + 2 < r.cells.length; i += 3) cells.set(r.cells[i], [r.cells[i + 1], r.cells[i + 2]]);
  return { t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, buy: r.buy, sell: r.sell, n: r.n, firstT: r.firstT, lastT: r.lastT, cells };
}

export async function saveMinutes(marketId: string, fine: number, minutes: MinuteFP[], segments: Segment[]): Promise<boolean> {
  try {
    const db = await openDb();
    if (!db) return false;
    return await new Promise<boolean>((resolve) => {
      const tx = db.transaction([MIN_STORE, META_STORE], "readwrite");
      const ms = tx.objectStore(MIN_STORE);
      for (const fp of minutes) ms.put(toRec(marketId, fine, fp));
      const meta: MetaRec = { m: marketId, fine, segments: segments.map((s) => ({ from: s.from, to: s.to, open: false })), savedAt: Date.now() };
      tx.objectStore(META_STORE).put(meta);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    });
  } catch {
    return false;
  }
}

export interface Restored {
  minutes: MinuteFP[];
  segments: Segment[];
}

export async function loadMinutes(marketId: string, fine: number, since: number): Promise<Restored | null> {
  try {
    const db = await openDb();
    if (!db) return null;
    return await new Promise<Restored | null>((resolve) => {
      const tx = db.transaction([MIN_STORE, META_STORE], "readonly");
      const out: Restored = { minutes: [], segments: [] };
      const metaReq = tx.objectStore(META_STORE).get(marketId);
      metaReq.onsuccess = () => {
        const meta = metaReq.result as MetaRec | undefined;
        if (meta && meta.fine === fine) out.segments = meta.segments.filter((s) => s.to >= since);
      };
      const idx = tx.objectStore(MIN_STORE).index("m_t");
      const cur = idx.openCursor(IDBKeyRange.bound([marketId, since], [marketId, Number.MAX_SAFE_INTEGER]));
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return;
        const r = c.value as MinuteRec;
        if (r.fine === fine) out.minutes.push(fromRec(r));
        c.continue();
      };
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    });
  } catch {
    return null;
  }
}

/** Delete persisted minutes older than `before` across all markets. */
export async function pruneBefore(before: number): Promise<void> {
  try {
    const db = await openDb();
    if (!db) return;
    await new Promise<void>((resolve) => {
      const tx = db.transaction([MIN_STORE], "readwrite");
      const store = tx.objectStore(MIN_STORE);
      const cur = store.openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return;
        if ((c.value as MinuteRec).t < before) c.delete();
        c.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    /* ignore */
  }
}

export async function clearMarket(marketId: string): Promise<void> {
  try {
    const db = await openDb();
    if (!db) return;
    await new Promise<void>((resolve) => {
      const tx = db.transaction([MIN_STORE, META_STORE], "readwrite");
      const idx = tx.objectStore(MIN_STORE).index("m_t");
      const cur = idx.openCursor(IDBKeyRange.bound([marketId, 0], [marketId, Number.MAX_SAFE_INTEGER]));
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return;
        c.delete();
        c.continue();
      };
      tx.objectStore(META_STORE).delete(marketId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    /* ignore */
  }
}
