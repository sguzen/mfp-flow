/**
 * Wire format between the recorder service and the app.
 *
 * It is deliberately the same shape the app already persists to IndexedDB —
 * minutes with their cells flattened to [row, buy, sell] triples, plus the
 * coverage segments that say which minutes are genuinely complete. Shared by
 * both sides so they cannot drift apart, and pure so the round trip is tested.
 *
 * Decoding treats its input as untrusted: the recorder URL is something the
 * user types in, so a malformed or hostile response must yield fewer minutes,
 * never a broken chart.
 */
import type { Segment } from "../analytics/footprint";
import type { MinuteFP } from "../analytics/types";

export interface WireMinute {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  buy: number;
  sell: number;
  n: number;
  firstT: number;
  lastT: number;
  /** flattened [row, buyVol, sellVol] triples */
  cells: number[];
}

export interface WireMinutes {
  market: string;
  /** fine row size in price units; minutes are only mergeable at a matching size */
  fine: number;
  minutes: WireMinute[];
  segments: Segment[];
}

export function encodeMinute(fp: MinuteFP): WireMinute {
  const cells: number[] = [];
  for (const [row, [b, s]] of fp.cells) cells.push(row, b, s);
  return { t: fp.t, o: fp.o, h: fp.h, l: fp.l, c: fp.c, buy: fp.buy, sell: fp.sell, n: fp.n, firstT: fp.firstT, lastT: fp.lastT, cells };
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Null when the record is not usable, so the caller can skip just that minute. */
export function decodeMinute(w: unknown): MinuteFP | null {
  if (!w || typeof w !== "object") return null;
  const r = w as Record<string, unknown>;
  const t = num(r.t);
  if (t == null) return null;
  const cells = new Map<number, [number, number]>();
  const raw = Array.isArray(r.cells) ? (r.cells as unknown[]) : [];
  // triples; a trailing partial triple is dropped rather than read as zeroes
  for (let i = 0; i + 2 < raw.length; i += 3) {
    const row = num(raw[i]);
    const b = num(raw[i + 1]);
    const s = num(raw[i + 2]);
    if (row == null || b == null || s == null) continue;
    cells.set(row, [b, s]);
  }
  return {
    t,
    o: num(r.o) ?? 0,
    h: num(r.h) ?? 0,
    l: num(r.l) ?? 0,
    c: num(r.c) ?? 0,
    buy: num(r.buy) ?? 0,
    sell: num(r.sell) ?? 0,
    n: num(r.n) ?? 0,
    firstT: num(r.firstT) ?? t,
    lastT: num(r.lastT) ?? t,
    cells,
  };
}

export function decodeSegment(v: unknown): Segment | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const from = num(r.from);
  const to = num(r.to);
  if (from == null || to == null || to < from) return null;
  return { from, to, open: r.open === true };
}

export interface DecodedMinutes {
  market: string;
  fine: number;
  minutes: MinuteFP[];
  segments: Segment[];
  /** records the server sent that could not be used */
  skipped: number;
}

export function decodeMinutes(body: unknown): DecodedMinutes | null {
  if (!body || typeof body !== "object") return null;
  const r = body as Record<string, unknown>;
  const fine = num(r.fine);
  if (fine == null || fine <= 0) return null;
  const market = typeof r.market === "string" ? r.market : "";
  const minutes: MinuteFP[] = [];
  let skipped = 0;
  for (const m of Array.isArray(r.minutes) ? r.minutes : []) {
    const d = decodeMinute(m);
    if (d) minutes.push(d);
    else skipped++;
  }
  const segments: Segment[] = [];
  for (const s of Array.isArray(r.segments) ? r.segments : []) {
    const d = decodeSegment(s);
    if (d) segments.push(d);
    else skipped++;
  }
  minutes.sort((a, b) => a.t - b.t);
  return { market, fine, minutes, segments, skipped };
}
