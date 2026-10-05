import { closeLocationDelta, distributeCandle } from "./estimate";
import { MINUTE } from "./footprint";
import { floorDiv } from "./price";
import { DevelopingProfile, Profile, RowAccum, ValueArea, profileFromRows, valueArea } from "./profile";
import { SessionSpec, sessionStart } from "./session";
import type { Bar, Candle, Cell, MinuteFP } from "./types";

/** Everything known about one market at minute resolution. */
export interface MinuteSource {
  /** real per-minute footprints at fine resolution */
  minutes: Map<number, MinuteFP>;
  /** 1m candles keyed by openTime */
  candles: Map<number, Candle>;
  /** true if every trade of minute m was recorded */
  isReal(m: number): boolean;
  /** fine row size (units) the footprints are stored at */
  fine: number;
  /** market tick (units), used for candle distribution */
  tick: number;
}

/** All minute keys with any data, ascending. */
export function minuteKeys(src: MinuteSource): number[] {
  const set = new Set<number>(src.candles.keys());
  for (const k of src.minutes.keys()) set.add(k);
  return [...set].sort((a, b) => a - b);
}

interface Acc {
  bar: Bar;
}

function addCell(cells: Map<number, Cell>, row: number, b: number, s: number, e: number) {
  let c = cells.get(row);
  if (!c) {
    c = { b: 0, s: 0, e: 0 };
    cells.set(row, c);
  }
  c.b += b;
  c.s += s;
  c.e += e;
}

/**
 * Fold one minute into a bar. Each minute contributes exactly one source of
 * volume: real trades, estimated candle volume, or (mixed) real trades plus
 * the candle volume not yet accounted for by recorded trades.
 */
function foldMinute(acc: Acc, src: MinuteSource, m: number, rowUnits: number): void {
  const bar = acc.bar;
  const fp = src.minutes.get(m);
  const cd = src.candles.get(m);
  const real = src.isReal(m);
  if (!fp && !cd) return;
  if (!fp && real) return; // fully covered, no trades: genuinely zero volume
  let o: number, h: number, l: number, c: number;
  let estVol = 0;
  if (fp) {
    const ratio = rowUnits / src.fine;
    for (const [k, [b, s]] of fp.cells) addCell(bar.cells, floorDiv(k, ratio), b, s, 0);
    bar.buy += fp.buy;
    bar.sell += fp.sell;
    bar.realDelta += fp.buy - fp.sell;
    o = fp.o;
    h = fp.h;
    l = fp.l;
    c = fp.c;
    if (!real && cd) {
      // Partially recorded minute: the remainder of the candle volume is estimated.
      // OHLC: the candle saw the whole minute (open, extremes); the latest recorded trade is the freshest close.
      estVol = Math.max(0, cd.v - (fp.buy + fp.sell));
      o = cd.o;
      h = Math.max(h, cd.h);
      l = Math.min(l, cd.l);
    }
  } else {
    const k = cd!;
    estVol = k.v;
    o = k.o;
    h = k.h;
    l = k.l;
    c = k.c;
  }
  if (estVol > 0 && cd) {
    for (const [row, v] of distributeCandle(cd, rowUnits, src.tick, estVol)) addCell(bar.cells, row, 0, 0, v);
    bar.estVol += estVol;
    bar.estDelta += closeLocationDelta(cd, estVol);
  }
  if (bar.minutes === 0) {
    bar.o = o;
    bar.h = h;
    bar.l = l;
  } else {
    if (h > bar.h) bar.h = h;
    if (l < bar.l) bar.l = l;
  }
  bar.c = c;
  bar.minutes++;
  if (real && fp) bar.realMinutes++;
  bar.vol = bar.buy + bar.sell + bar.estVol;
}

function newBar(t: number, dur: number, session: number): Bar {
  return {
    t,
    dur,
    o: 0,
    h: 0,
    l: 0,
    c: 0,
    vol: 0,
    buy: 0,
    sell: 0,
    estVol: 0,
    realDelta: 0,
    estDelta: 0,
    realMinutes: 0,
    minutes: 0,
    cells: new Map(),
    session,
  };
}

/** Build one bar covering [t, t + barMs). Returns null if it has no data. */
export function buildBar(src: MinuteSource, t: number, barMs: number, rowUnits: number, session: SessionSpec): Bar | null {
  const acc: Acc = { bar: newBar(t, barMs, sessionStart(t, session)) };
  for (let m = t; m < t + barMs; m += MINUTE) foldMinute(acc, src, m, rowUnits);
  return acc.bar.minutes > 0 ? acc.bar : null;
}

/** Build all bars for the given (sorted) minute keys. Bars never straddle a session start. */
export function buildBars(src: MinuteSource, keys: number[], barMs: number, rowUnits: number, session: SessionSpec): Bar[] {
  const bars: Bar[] = [];
  let cur: Acc | null = null;
  for (const m of keys) {
    const ss = sessionStart(m, session);
    const t = ss + Math.floor((m - ss) / barMs) * barMs;
    if (!cur || cur.bar.t !== t) {
      if (cur && cur.bar.minutes > 0) bars.push(cur.bar);
      cur = { bar: newBar(t, barMs, ss) };
    }
    foldMinute(cur, src, m, rowUnits);
  }
  if (cur && cur.bar.minutes > 0) bars.push(cur.bar);
  return bars;
}

export function barDelta(b: Bar, includeEstimate: boolean): number {
  return b.realDelta + (includeEstimate ? b.estDelta : 0);
}

export interface SessionStats {
  start: number;
  /** index range into bars, inclusive */
  i0: number;
  i1: number;
  profile: Profile;
  va: ValueArea | null;
  /** high / low in price units */
  high: number;
  low: number;
  /** developing POC row after each bar of the session (index i - i0) */
  dpoc: (number | null)[];
  /** volume share that comes from recorded trades */
  realShare: number;
  realDelta: number;
  estDelta: number;
  volume: number;
}

/** Group bars into sessions and compute the profile, value area and developing POC for each. */
export function buildSessions(bars: Bar[], vaPct = 0.7): SessionStats[] {
  const out: SessionStats[] = [];
  let i = 0;
  while (i < bars.length) {
    const start = bars[i].session;
    let j = i;
    while (j + 1 < bars.length && bars[j + 1].session === start) j++;
    const rows = new Map<number, RowAccum>();
    const dev = new DevelopingProfile();
    const dpoc: (number | null)[] = [];
    let high = -Infinity;
    let low = Infinity;
    let real = 0;
    let vol = 0;
    let rd = 0;
    let ed = 0;
    for (let k = i; k <= j; k++) {
      const b = bars[k];
      for (const [row, c] of b.cells) {
        let r = rows.get(row);
        if (!r) {
          r = { b: 0, s: 0, e: 0 };
          rows.set(row, r);
        }
        r.b += c.b;
        r.s += c.s;
        r.e += c.e;
        dev.add(row, c.b + c.s + c.e);
      }
      dpoc.push(dev.poc());
      if (b.h > high) high = b.h;
      if (b.l < low) low = b.l;
      real += b.buy + b.sell;
      vol += b.vol;
      rd += b.realDelta;
      ed += b.estDelta;
    }
    const profile = profileFromRows(rows);
    out.push({
      start,
      i0: i,
      i1: j,
      profile,
      va: valueArea(profile, vaPct),
      high,
      low,
      dpoc,
      realShare: vol > 0 ? real / vol : 0,
      realDelta: rd,
      estDelta: ed,
      volume: vol,
    });
    i = j + 1;
  }
  return out;
}

/** Cumulative delta per bar. Resets at each session start when `perSession`. */
export function cvdSeries(bars: Bar[], includeEstimate: boolean, perSession = true): number[] {
  const out: number[] = new Array(bars.length);
  let acc = 0;
  for (let i = 0; i < bars.length; i++) {
    if (perSession && i > 0 && bars[i].session !== bars[i - 1].session) acc = 0;
    acc += barDelta(bars[i], includeEstimate);
    out[i] = acc;
  }
  return out;
}
