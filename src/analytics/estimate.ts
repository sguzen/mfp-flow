import { bucketOf } from "./price";
import type { Candle } from "./types";

/**
 * Distribute a candle's volume across the rows it traded through.
 *
 * The candle's price range is treated as the continuous interval
 * [low, high + tick) — every traded price p "occupies" [p, p + tick) — and
 * each row receives volume proportional to its overlap with that interval.
 * This is an ESTIMATE: real intra-minute distribution is unknown.
 *
 * Returns [row, volume] pairs; volumes sum to `vol` (default candle.v).
 */
export function distributeCandle(c: Candle, rowUnits: number, tickUnits: number, vol = c.v): Array<[number, number]> {
  if (!(vol > 0)) return [];
  const tick = Math.max(1, tickUnits);
  const lo = c.l;
  const hi = c.h + tick;
  const r0 = bucketOf(c.l, rowUnits);
  const r1 = bucketOf(c.h, rowUnits);
  if (r0 === r1) return [[r0, vol]];
  const span = hi - lo;
  const out: Array<[number, number]> = [];
  for (let k = r0; k <= r1; k++) {
    const a = Math.max(lo, k * rowUnits);
    const b = Math.min(hi, (k + 1) * rowUnits);
    const w = (b - a) / span;
    if (w > 0) out.push([k, vol * w]);
  }
  return out;
}

/**
 * Close-location delta estimate: vol × (2·(close − low)/(high − low) − 1).
 * +vol when the candle closes on its high, −vol on its low, 0 for a doji or
 * a zero-range candle. A crude proxy, labelled "estimated" wherever shown.
 */
export function closeLocationDelta(c: Candle, vol = c.v): number {
  const range = c.h - c.l;
  if (!(range > 0) || !(vol > 0)) return 0;
  return vol * ((2 * (c.c - c.l)) / range - 1);
}
