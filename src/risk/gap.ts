// Stop-gap model. A stop triggers on last price but fills at a fresh market
// price, so the fill can land past the trigger. We estimate how far, in bps,
// from recent candles of the same market.
//
// typical: median 1-second high-low range (an ordinary tick-through)
// stress:  99th percentile high-low range over a short window (default 3s),
//          i.e. a fast move that runs through the stop while it executes.

import type { GapModel } from "./types";

export interface Bar {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function quantile(values: number[], q: number): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function rangeBps(high: number, low: number, ref: number) {
  return ref > 0 ? ((high - low) / ref) * 10_000 : 0;
}

/** Build the model from 1-second bars (preferred). */
export function gapFromSecondBars(bars: Bar[], windowBars = 3): GapModel | null {
  const live = bars.filter((b) => b.volume > 0 && b.open > 0);
  if (live.length < 60) return null;
  const single = live.map((b) => rangeBps(b.high, b.low, b.open));
  const windows: number[] = [];
  for (let i = 0; i + windowBars <= bars.length; i++) {
    const w = bars.slice(i, i + windowBars);
    if (!w.some((b) => b.volume > 0) || w[0].open <= 0) continue;
    const hi = Math.max(...w.map((b) => b.high));
    const lo = Math.min(...w.map((b) => b.low));
    windows.push(rangeBps(hi, lo, w[0].open));
  }
  return {
    typicalBps: round2(quantile(single, 0.5)),
    stressBps: round2(quantile(windows, 0.99)),
    source: `${live.length} active 1s bars (typical = median 1s range, stress = p99 ${windowBars}s range)`,
    sampleSize: live.length,
  };
}

/**
 * Fallback from 1-minute bars, scaled to a seconds horizon by sqrt(time).
 *
 * Dead bars are dropped, as in the 1s path: a market that printed no trades
 * for a minute reports a zero range, and on a thin market those zeros are
 * numerous enough to drag the median to 0 — which would make the typical
 * scenario identical to the clean one and hide the gap entirely.
 */
export function gapFromMinuteBars(bars: Bar[], windowSeconds = 3): GapModel | null {
  const live = bars.filter((b) => b.volume > 0 && b.open > 0);
  if (live.length < 30) return null;
  const r = live.map((b) => rangeBps(b.high, b.low, b.open));
  return {
    typicalBps: round2(quantile(r, 0.5) / Math.sqrt(60)),
    stressBps: round2(quantile(r, 0.99) * Math.sqrt(windowSeconds / 60)),
    source: `${live.length} active 1m bars scaled by sqrt(time) (no 1s history from this provider)`,
    sampleSize: live.length,
  };
}

/** Conservative default when no history is available at all. */
export function defaultGap(): GapModel {
  return { typicalBps: 2, stressBps: 25, source: "default (no candle history)", sampleSize: 0 };
}

function round2(x: number) {
  return Math.round(x * 100) / 100;
}
