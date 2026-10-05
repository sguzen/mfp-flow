/**
 * Open-interest history for Binance-provider markets.
 *
 * MFP's stream carries live OI but keeps no history, so days you were not
 * watching have none. Binance publishes it for its own perps and serves it with
 * `access-control-allow-origin: *`, so the page can read it directly.
 *
 * Measured against the live endpoint on Oct 5, 2026: one request returns at
 * most 500 rows, so the period has to be chosen to cover the window asked for —
 * 5m reaches 1.74 days, 15m 5.2, 30m 10.4, 1h 20.8. Roughly 30 days is all that
 * is retained at any period. The series is therefore coarser than the chart's
 * bars, and is labelled as such rather than pretending to per-bar precision.
 *
 * Hyperliquid (`xyz:` markets) has no OI history at all — only a current value,
 * which duplicates what MFP already streams — so those markets get live OI only.
 */
export type OiPeriod = "5m" | "15m" | "30m" | "1h" | "4h";

/** Minutes covered by one 500-row page at each period. */
const SPAN_MIN: Record<OiPeriod, number> = { "5m": 5 * 500, "15m": 15 * 500, "30m": 30 * 500, "1h": 60 * 500, "4h": 240 * 180 };
const PERIODS: OiPeriod[] = ["5m", "15m", "30m", "1h", "4h"];

/** The finest period whose single page covers `days`. */
export function periodFor(days: number): OiPeriod {
  const need = days * 24 * 60;
  return PERIODS.find((p) => SPAN_MIN[p] >= need) ?? "4h";
}

export interface OiPoint {
  t: number;
  /** USD notional, matching MFP's openInterestUsd */
  usd: number;
}

export interface OiHistory {
  points: OiPoint[];
  period: OiPeriod;
  source: "binance";
}

/** Binance returns strings; anything unparseable is dropped, not zeroed. */
export function parseOiHistory(body: unknown, period: OiPeriod): OiHistory | null {
  if (!Array.isArray(body)) return null;
  const points: OiPoint[] = [];
  for (const row of body) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const t = Number(r.timestamp);
    const usd = Number(r.sumOpenInterestValue);
    if (!Number.isFinite(t) || !Number.isFinite(usd) || usd <= 0) continue;
    points.push({ t, usd });
  }
  points.sort((a, b) => a.t - b.t);
  return { points, period, source: "binance" };
}

/** The Binance symbol behind an MFP market, or null when it is not a Binance perp. */
export function binanceSymbol(market: { provider: string; coin: string }): string | null {
  return market.provider === "binance" && !market.coin.includes(":") ? market.coin.toUpperCase() : null;
}

export interface OiHistoryResult {
  history: OiHistory | null;
  /** one line for the panel when there is nothing to show */
  note: string | null;
}

/**
 * Fetch OI history for a Binance market. Never throws: Binance answers 451 from
 * some regions, and the honest outcome there is live OI with a note, not a
 * broken chart.
 */
export async function fetchOiHistory(
  symbol: string,
  days: number,
  timeoutMs = 8000,
  base = "https://fapi.binance.com",
): Promise<OiHistoryResult> {
  const period = periodFor(days);
  const url = `${base}/futures/data/openInterestHist?symbol=${encodeURIComponent(symbol)}&period=${period}&limit=500`;
  try {
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = setTimeout(() => ctl?.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctl?.signal, credentials: "omit" });
    clearTimeout(timer);
    if (res.status === 451) return { history: null, note: "OI history unavailable from your region." };
    if (!res.ok) return { history: null, note: `OI history unavailable (HTTP ${res.status}).` };
    const parsed = parseOiHistory(await res.json(), period);
    if (!parsed || !parsed.points.length) return { history: null, note: "OI history returned nothing for this market." };
    return { history: parsed, note: null };
  } catch (e) {
    // a CORS rejection surfaces here as a TypeError, same as a network failure
    const why = (e as Error).name === "AbortError" ? "timed out" : "unreachable";
    return { history: null, note: `OI history ${why}; using live OI only.` };
  }
}
