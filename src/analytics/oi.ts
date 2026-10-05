/**
 * Open interest: change per bar, and the standard four-way reading of price
 * against OI.
 *
 * This describes what the position base did while price moved. It is context,
 * never a recommendation, and it is deliberately conservative: a move too small
 * to mean anything reads "flat" rather than being forced into a direction, and
 * a bar with no OI data reads as nothing at all rather than as zero.
 *
 *   price up,   OI up    new longs          (with buying delta: initiative buying)
 *   price up,   OI down  short covering
 *   price down, OI up    new shorts
 *   price down, OI down  long liquidation
 */

export type OiRegime = "new-longs" | "short-covering" | "new-shorts" | "long-liquidation" | "flat";

export interface OiReading {
  regime: OiRegime;
  label: string;
  /** OI change over the bar, in the same units as the series (USD notional) */
  deltaOi: number;
  /** that change as a fraction of the opening OI */
  deltaOiPct: number;
}

/** Below this share of the opening OI, a change is noise rather than a story. */
export const OI_DEAD_ZONE = 0.001; // 0.1%

const LABELS: Record<OiRegime, string> = {
  "new-longs": "new longs",
  "short-covering": "short covering",
  "new-shorts": "new shorts",
  "long-liquidation": "long liquidation",
  flat: "flat",
};

export interface ClassifyInput {
  /** OI at the start and end of the bar; null when not recorded */
  oiOpen: number | null;
  oiClose: number | null;
  /** price at the start and end of the bar */
  priceOpen: number;
  priceClose: number;
  /** real aggressor delta for the bar, when it is known */
  delta?: number | null;
  deadZone?: number;
}

/**
 * Null when OI is unknown for the bar — the caller must leave it blank rather
 * than drawing a zero, which would read as "no change" when it means "no data".
 */
export function classifyOi(i: ClassifyInput): OiReading | null {
  const { oiOpen, oiClose } = i;
  if (oiOpen == null || oiClose == null || !Number.isFinite(oiOpen) || !Number.isFinite(oiClose)) return null;
  const deltaOi = oiClose - oiOpen;
  const deltaOiPct = oiOpen > 0 ? deltaOi / oiOpen : 0;
  const dead = i.deadZone ?? OI_DEAD_ZONE;
  const dPrice = i.priceClose - i.priceOpen;

  // too small an OI move, or no price direction, is not one of the four stories
  if (Math.abs(deltaOiPct) < dead || dPrice === 0) {
    return { regime: "flat", label: LABELS.flat, deltaOi, deltaOiPct };
  }

  const up = dPrice > 0;
  const oiUp = deltaOi > 0;
  const regime: OiRegime = up ? (oiUp ? "new-longs" : "short-covering") : oiUp ? "new-shorts" : "long-liquidation";
  // only the new-longs case gets the stronger reading, and only when the
  // recorded aggressor delta agrees with it
  const initiative = regime === "new-longs" && typeof i.delta === "number" && i.delta > 0;
  return { regime, label: initiative ? "initiative buying" : LABELS[regime], deltaOi, deltaOiPct };
}

/**
 * Carry an OI series forward over minutes that were never sampled. OI is a
 * level, not a flow: between two observations it is unchanged as far as anyone
 * knows, but before the first observation it is genuinely unknown.
 */
export function carryForward(samples: Map<number, number>, minutes: number[]): (number | null)[] {
  let last: number | null = null;
  return minutes.map((t) => {
    const v = samples.get(t);
    if (v != null && Number.isFinite(v)) last = v;
    return last;
  });
}

/** OI at the open and close of a bar spanning `minutes`, from a per-minute series. */
export function barOi(series: (number | null)[], from: number, to: number): { open: number | null; close: number | null } {
  let open: number | null = null;
  let close: number | null = null;
  for (let i = from; i <= to && i < series.length; i++) {
    const v = series[i];
    if (v == null) continue;
    if (open == null) open = v;
    close = v;
  }
  return { open, close };
}
