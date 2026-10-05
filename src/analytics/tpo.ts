/**
 * Market Profile (TPO) per session, built from period high/low only.
 * TPO is time-at-price, so it needs no volume or trade side: built from
 * 1-minute candles it is exact for every past session, unlike the volume
 * profile, whose history is estimated.
 *
 * Conventions:
 *  - Period = 30 minutes, aligned to the session start. Letters A–X then a–x.
 *  - A period "prints" every row from floor(low/row) to floor(high/row).
 *  - TPO POC: the row with most TPOs; ties → closest to the range midpoint, then lower.
 *  - Value area: the same two-rows-at-a-time expansion as volume, on TPO counts.
 *  - Initial balance (IB): the first `ibPeriods` periods (default 2 = first hour).
 *  - Single prints: rows touched by exactly one period, inside the range or in a tail.
 *  - Excess (tail): >= 2 single-print rows at an extreme. Poor high/low: the
 *    extreme row has >= 2 TPOs (the auction ended without excess there).
 */
import { profileFromVolumes, valueArea, type ValueArea } from "./profile";

export const TPO_PERIOD_MS = 30 * 60_000;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXabcdefghijklmnopqrstuvwx";

export function tpoLetter(period: number): string {
  return LETTERS[period] ?? "·";
}

export interface TpoPeriodInput {
  /** period open time (ms) */
  t: number;
  /** high / low in price units */
  h: number;
  l: number;
}

export interface TpoProfile {
  start: number;
  /** lowest / highest row */
  lo: number;
  hi: number;
  /** periods printed per row, row lo+i -> ascending period indices */
  rows: number[][];
  /** number of periods in the session */
  periods: number;
  poc: number | null;
  va: ValueArea | null;
  ib: { hiRow: number; loRow: number } | null;
  /** IB extension: rows traded above/below the IB after the IB */
  rangeExtUp: boolean;
  rangeExtDown: boolean;
  singlePrints: { from: number; to: number }[];
  /** number of single-print rows at the top / bottom extreme (excess tail length) */
  topTail: number;
  bottomTail: number;
  poorHigh: boolean;
  poorLow: boolean;
  /** TPO count per row (dense, same indexing as rows) */
  counts: number[];
}

/**
 * Build the TPO profile of one session from its periods.
 * `periods` must belong to one session (any order); `start` is the session start.
 */
export function buildTpo(start: number, periods: TpoPeriodInput[], rowUnits: number, vaPct = 0.7, ibPeriods = 2): TpoProfile | null {
  if (!periods.length) return null;
  const ps = [...periods].sort((a, b) => a.t - b.t);
  const idxOf = (t: number) => Math.floor((t - start) / TPO_PERIOD_MS);
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of ps) {
    lo = Math.min(lo, Math.floor(p.l / rowUnits));
    hi = Math.max(hi, Math.floor(p.h / rowUnits));
  }
  const rows: number[][] = Array.from({ length: hi - lo + 1 }, () => []);
  let lastIdx = 0;
  for (const p of ps) {
    const k = idxOf(p.t);
    lastIdx = Math.max(lastIdx, k);
    for (let r = Math.floor(p.l / rowUnits); r <= Math.floor(p.h / rowUnits); r++) {
      const cell = rows[r - lo];
      if (cell[cell.length - 1] !== k) cell.push(k);
    }
  }
  const counts = rows.map((r) => r.length);
  const vol: Record<number, number> = {};
  counts.forEach((c, i) => {
    if (c > 0) vol[lo + i] = c;
  });
  const prof = profileFromVolumes(vol);
  const va = valueArea(prof, vaPct);

  // initial balance
  const ibBars = ps.filter((p) => idxOf(p.t) < ibPeriods);
  const ib = ibBars.length
    ? { hiRow: Math.max(...ibBars.map((p) => Math.floor(p.h / rowUnits))), loRow: Math.min(...ibBars.map((p) => Math.floor(p.l / rowUnits))) }
    : null;
  const after = ps.filter((p) => idxOf(p.t) >= ibPeriods);
  const rangeExtUp = !!ib && after.some((p) => Math.floor(p.h / rowUnits) > ib.hiRow);
  const rangeExtDown = !!ib && after.some((p) => Math.floor(p.l / rowUnits) < ib.loRow);

  // single prints (runs of count === 1)
  const singlePrints: { from: number; to: number }[] = [];
  let run: { from: number; to: number } | null = null;
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] === 1) {
      if (run) run.to = lo + i;
      else run = { from: lo + i, to: lo + i };
    } else if (run) {
      singlePrints.push(run);
      run = null;
    }
  }
  if (run) singlePrints.push(run);

  let topTail = 0;
  for (let i = counts.length - 1; i >= 0 && counts[i] === 1; i--) topTail++;
  let bottomTail = 0;
  for (let i = 0; i < counts.length && counts[i] === 1; i++) bottomTail++;

  // A finished single-period session cannot judge excess.
  const judge = lastIdx >= 1;
  return {
    start,
    lo,
    hi,
    rows,
    periods: lastIdx + 1,
    poc: va?.poc ?? null,
    va,
    ib,
    rangeExtUp,
    rangeExtDown,
    singlePrints,
    topTail,
    bottomTail,
    poorHigh: judge && counts[counts.length - 1] >= 2,
    poorLow: judge && counts[0] >= 2,
    counts,
  };
}
