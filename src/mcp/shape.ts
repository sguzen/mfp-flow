/**
 * Response shaping for the MCP server: turns the same structures the web app
 * renders into JSON an agent can read. Pure, so it is unit-tested over fixture
 * sessions rather than a live socket.
 *
 * Two rules hold everywhere here:
 *  - Prices are decimal strings at the market's tick. No thousands separators:
 *    a consumer has to be able to parse them back.
 *  - Row indices follow the web app exactly — POC and VAL at the row's low,
 *    VAH at the row's top — so the numbers match the chart for the same
 *    settings rather than being off by one row.
 */
import { locationVsValue, valueRelation, type FailedAuction, type NakedPoc, type PoorExtreme } from "../analytics/auction";
import { PRICE_SCALE } from "../analytics/price";
import type { ValueArea } from "../analytics/profile";
import type { SessionStats } from "../analytics/series";
import type { TpoProfile } from "../analytics/tpo";

/** Plain decimal, no grouping, computed on the integer units to avoid float drift. */
export function priceStr(units: number, dp: number): string {
  const neg = units < 0;
  const s = String(Math.abs(Math.round(units))).padStart(9, "0");
  const cut = s.length - 8;
  const int = s.slice(0, cut);
  const frac = s.slice(cut, cut + Math.max(0, dp));
  return (neg ? "-" : "") + int + (dp > 0 ? "." + frac.padEnd(dp, "0") : "");
}

export interface Px {
  (units: number): string;
}
/** Formatter at the market tick, never coarser than the row size. */
export function pxAt(dp: number): Px {
  return (u: number) => priceStr(u, dp);
}

/**
 * Round half away from zero. Math.round rounds half toward +Infinity, which
 * would report -12.345 as -12.34 but +12.345 as +12.35 — a sign-dependent bias
 * in signed figures like delta and distance.
 */
export function roundTo(n: number, places: number): number {
  const f = 10 ** places;
  return (Math.sign(n) * Math.round(Math.abs(n) * f)) / f;
}

export const rowLo = (r: number, row: number) => r * row;
export const rowHi = (r: number, row: number) => (r + 1) * row;

/** What is exact and what is inferred. Every tool response carries this. */
export interface DataQuality {
  volume_profile: string;
  delta: string;
  tpo: string;
  real_volume_share_pct: number;
  open_interest: string;
}
export function dataQuality(realShare: number, realSince: number | null, oi?: { live: boolean; history: string | null }): DataQuality {
  const pct = Math.round(realShare * 1000) / 10;
  return {
    volume_profile: `Volume is exact; the buy/sell split is real for ${pct}% of it and rebuilt from 1-minute candles for the rest.`,
    delta: realSince
      ? `Aggressor delta is real only from ${new Date(realSince).toISOString()}, when this server started recording. Earlier bars report no delta.`
      : "No live trades recorded yet, so aggressor delta is unavailable for this window.",
    tpo: "TPO is time at price, rebuilt from 1-minute highs and lows, so it is exact for every past session.",
    real_volume_share_pct: pct,
    open_interest: oi
      ? oi.history
        ? `Live OI from the MFP stream, backfilled from ${oi.history}. Sessions with no observation report null rather than zero.`
        : "Live OI from the MFP stream only; this venue publishes no OI history, so earlier sessions may report null."
      : "Open interest was not observed for this request.",
  };
}

export interface OiRow {
  change_pct: number;
  reading: string;
}

/** Null when OI was never observed for the session, so the agent is not told zero. */
export function shapeOi(r: { deltaOiPct: number; label: string } | null): OiRow | null {
  return r ? { change_pct: roundTo(r.deltaOiPct * 100, 3), reading: r.label } : null;
}

export interface SessionRow {
  date: string;
  start: string;
  poc: string | null;
  vah: string | null;
  val: string | null;
  high: string;
  low: string;
  volume: number;
  real_share_pct: number;
  value_vs_prior: string | null;
  open_interest: OiRow | null;
}

export function shapeSessions(
  sessions: SessionStats[],
  row: number,
  px: Px,
  oi: ({ deltaOiPct: number; label: string } | null)[] = [],
): SessionRow[] {
  return sessions.map((s, i) => {
    const prior = i > 0 ? sessions[i - 1] : null;
    return {
      date: new Date(s.start).toISOString().slice(0, 10),
      start: new Date(s.start).toISOString(),
      poc: s.va ? px(rowLo(s.va.poc, row)) : null,
      vah: s.va ? px(rowHi(s.va.vah, row)) : null,
      val: s.va ? px(rowLo(s.va.val, row)) : null,
      high: px(s.high),
      low: px(s.low),
      volume: Math.round(s.volume),
      real_share_pct: Math.round(s.realShare * 1000) / 10,
      value_vs_prior: s.va && prior?.va ? valueRelation(s.va, prior.va) : null,
      open_interest: shapeOi(oi[i] ?? null),
    };
  });
}

export interface TpoRow {
  date: string;
  periods: number;
  tpo_poc: string | null;
  tpo_vah: string | null;
  tpo_val: string | null;
  initial_balance: { high: string; low: string; range: string } | null;
  range_extension: "up" | "down" | "both" | "none";
  single_prints: { from: string; to: string }[];
  tails: { top_rows: number; bottom_rows: number };
  poor_high: boolean;
  poor_low: boolean;
}

export function shapeTpo(sessions: SessionStats[], tpo: (TpoProfile | null)[], row: number, px: Px): TpoRow[] {
  const out: TpoRow[] = [];
  for (let i = 0; i < sessions.length; i++) {
    const t = tpo[i];
    if (!t) continue;
    out.push({
      date: new Date(t.start).toISOString().slice(0, 10),
      periods: t.periods,
      tpo_poc: t.va ? px(rowLo(t.va.poc, row)) : null,
      tpo_vah: t.va ? px(rowHi(t.va.vah, row)) : null,
      tpo_val: t.va ? px(rowLo(t.va.val, row)) : null,
      initial_balance: t.ib
        ? {
            high: px(rowHi(t.ib.hiRow, row)),
            low: px(rowLo(t.ib.loRow, row)),
            range: px(rowHi(t.ib.hiRow, row) - rowLo(t.ib.loRow, row)),
          }
        : null,
      range_extension: t.rangeExtUp && t.rangeExtDown ? "both" : t.rangeExtUp ? "up" : t.rangeExtDown ? "down" : "none",
      single_prints: t.singlePrints.map((r) => ({ from: px(rowLo(r.from, row)), to: px(rowHi(r.to, row)) })),
      tails: { top_rows: t.topTail, bottom_rows: t.bottomTail },
      poor_high: t.poorHigh,
      poor_low: t.poorLow,
    });
  }
  return out;
}

export interface NakedRow {
  price: string;
  session: string;
  distance_pct: number | null;
}
export function shapeNaked(naked: NakedPoc[], row: number, px: Px, last: number | null): NakedRow[] {
  return naked.map((n) => {
    const p = rowLo(n.row, row);
    return {
      price: px(p),
      session: new Date(n.session).toISOString().slice(0, 10),
      distance_pct: last ? roundTo(((p - last) / last) * 100, 2) : null,
    };
  });
}

export interface FailedRow {
  reference: string;
  direction: "above" | "below";
  extreme: string;
  excursion_delta: number | null;
  delta_quality: "real" | "estimated" | "mixed";
  delta_supported_break: boolean | null;
}
export function shapeFailed(failed: FailedAuction[], px: Px): FailedRow[] {
  return failed.map((f) => ({
    reference: f.ref.label,
    direction: f.ref.dir === 1 ? "above" : "below",
    extreme: px(f.extreme),
    // only report delta we actually recorded; estimated delta is not claimed
    excursion_delta: f.deltaQuality === "real" ? roundTo(f.excursionDelta, 2) : null,
    delta_quality: f.deltaQuality,
    delta_supported_break: f.deltaQuality === "real" ? f.supported : null,
  }));
}

export function shapePoor(poor: PoorExtreme[], row: number, px: Px) {
  return poor.map((p) => ({
    kind: p.kind,
    price: p.kind === "poor-high" ? px(rowHi(p.row, row)) : px(rowLo(p.row, row)),
  }));
}

/** "outside" and "inside" do not take "than", so each relation gets its phrase. */
const RELATION_PHRASE: Record<string, string> = {
  higher: "value higher than prior",
  lower: "value lower than prior",
  "overlapping-higher": "value overlapping higher than prior",
  "overlapping-lower": "value overlapping lower than prior",
  unchanged: "value unchanged from prior",
  inside: "value inside prior value",
  outside: "value outside prior value",
};
export function relationPhrase(rel: string): string {
  return RELATION_PHRASE[rel] ?? `value ${rel} vs prior`;
}

/** One line an agent can quote without re-deriving anything. */
export function levelsSummary(o: {
  market: string;
  last: string | null;
  location: ReturnType<typeof locationVsValue> | null;
  relation: string | null;
  naked: number;
  failed: number;
}): string {
  const bits = [`${o.market} last ${o.last ?? "unknown"}`];
  if (o.location) bits.push(`${o.location} today's value area`);
  if (o.relation) bits.push(relationPhrase(o.relation));
  bits.push(`${o.naked} naked POC${o.naked === 1 ? "" : "s"}`);
  bits.push(`${o.failed} failed auction${o.failed === 1 ? "" : "s"} today`);
  return bits.join(" · ") + ". Context, not signals.";
}

export function vaOf(va: ValueArea | null, row: number, px: Px) {
  return va ? { poc: px(rowLo(va.poc, row)), vah: px(rowHi(va.vah, row)), val: px(rowLo(va.val, row)) } : null;
}

export { PRICE_SCALE };
