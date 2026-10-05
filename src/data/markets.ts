import snapshot from "./markets.snapshot.json";
import type { SessionSpec } from "../analytics/session";

export const MARKETS_URL = "https://developers.myfundedperpetuals.com/v1/markets";

export interface Market {
  market_id: string;
  provider: string;
  /** display label */
  symbol: string;
  /** stream symbol */
  coin: string;
  size_decimals: number;
  max_leverage?: number;
}

export interface MarketList {
  markets: Market[];
  source: "live" | "snapshot";
  note?: string;
}

function parse(data: any): Market[] {
  const arr = Array.isArray(data) ? data : data?.data;
  if (!Array.isArray(arr)) throw new Error("unexpected /v1/markets shape");
  return arr
    .filter((m: any) => m && typeof m.coin === "string" && typeof m.provider === "string")
    .map((m: any) => ({
      market_id: String(m.market_id ?? `${m.provider}|${m.coin}`),
      provider: m.provider,
      symbol: String(m.symbol ?? m.coin),
      coin: m.coin,
      size_decimals: Number(m.size_decimals ?? 3),
      max_leverage: m.max_leverage,
    }));
}

/**
 * GET /v1/markets is public, but (as of Oct 2026) its CORS header only allows
 * the docs origin, so browsers on other origins cannot read it. We try it and
 * fall back to a snapshot bundled at build time (`npm run markets` refreshes it).
 */
export async function loadMarkets(timeoutMs = 6000): Promise<MarketList> {
  try {
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = setTimeout(() => ctl?.abort(), timeoutMs);
    const res = await fetch(MARKETS_URL, { signal: ctl?.signal, credentials: "omit" });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = parse(await res.json());
    if (list.length) return { markets: sortMarkets(list), source: "live" };
    throw new Error("empty market list");
  } catch (e) {
    return {
      markets: sortMarkets(parse(snapshot)),
      source: "snapshot",
      note: `Live market list unavailable from this origin (${(e as Error).message || "blocked"}); using the bundled snapshot.`,
    };
  }
}

export const FEATURED = ["binance|BTCUSDT", "binance|ETHUSDT", "hyperliquid|xyz:XYZ100", "hyperliquid|xyz:GOLD", "hyperliquid|xyz:SP500", "binance|SOLUSDT"];

function sortMarkets(ms: Market[]): Market[] {
  const rank = (m: Market) => {
    const i = FEATURED.indexOf(m.market_id);
    return i >= 0 ? i : 100;
  };
  return [...ms].sort((a, b) => rank(a) - rank(b) || a.symbol.localeCompare(b.symbol));
}

/** Friendly names for HL "xyz" TradFi perps. */
export const ALIASES: Record<string, string> = {
  "xyz:XYZ100": "NAS100",
  "xyz:SP500": "S&P 500",
  "xyz:GOLD": "Gold",
  "xyz:SILVER": "Silver",
  "xyz:BRENTOIL": "Brent",
  "xyz:JP225": "Nikkei 225",
};

export function marketLabel(m: Market): string {
  const alias = ALIASES[m.coin];
  return alias && alias.toUpperCase() !== m.symbol.toUpperCase() ? `${m.symbol} (${alias})` : m.symbol;
}

/** TradFi-style markets (HL "xyz:" perps on indices, metals, energy, stocks, FX). */
export function isTradFi(m: Market): boolean {
  return m.coin.startsWith("xyz:");
}

export function defaultSession(m: Market): SessionSpec {
  return isTradFi(m) ? { mode: "ny18" } : { mode: "utc" };
}

export const DEFAULT_MARKET_ID = "binance|BTCUSDT";
