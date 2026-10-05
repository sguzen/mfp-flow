/** Normalised market-data records. Prices are integer units (see price.ts), sizes are base-asset floats. */

export type Side = 1 | -1; // +1 = buy aggressor (lifted the offer), -1 = sell aggressor (hit the bid)

export interface Trade {
  id: string;
  /** exchange time, ms */
  t: number;
  /** price in units */
  px: number;
  /** size in base asset */
  sz: number;
  side: Side;
}

export interface Candle {
  /** openTime ms */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** base volume */
  v: number;
}

/** Real per-minute footprint built from live trades at the fine row size. */
export interface MinuteFP {
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
  /** fine row index -> [buyVol, sellVol] */
  cells: Map<number, [number, number]>;
}

/**
 * real  = the minute is fully covered by the live trade stream
 * mixed = partially covered (e.g. the minute the page opened): real trades + estimated remainder
 * est   = no trades recorded; volume distributed from the 1m candle
 */
export type Source = "real" | "mixed" | "est";

export interface Cell {
  /** real aggressor buy volume */
  b: number;
  /** real aggressor sell volume */
  s: number;
  /** estimated (side-unknown) volume distributed from candles */
  e: number;
}

export interface Bar {
  /** bar open time */
  t: number;
  /** bar interval ms */
  dur: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** total volume (real + est), base units */
  vol: number;
  buy: number;
  sell: number;
  /** estimated (side-unknown) volume */
  estVol: number;
  /** real delta (buy - sell) from recorded trades */
  realDelta: number;
  /** close-location estimate of delta for the estimated volume */
  estDelta: number;
  /** minutes that are fully real / minutes with any data */
  realMinutes: number;
  minutes: number;
  /** display row index -> cell */
  cells: Map<number, Cell>;
  /** start of the session this bar belongs to */
  session: number;
}

export function barSource(b: Bar): Source {
  if (b.estVol <= 0 && b.realMinutes === b.minutes) return "real";
  if (b.buy + b.sell > 0) return "mixed";
  return "est";
}
