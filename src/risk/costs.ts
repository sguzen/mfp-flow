// Fee, swap and slippage-cap schedules, transcribed from the MyFundedPerps docs
// (Commissions and Fees; Trading Guide > How market orders fill). Values are
// basis points. Keep them in one place: the docs say these can change.

import type { AssetClass, MarketInfo } from "./types";

const FX_COINS = new Set(["EUR", "JPY", "GBP", "AUD", "CAD", "CHF", "NZD", "CNH", "MXN"]);
const MAJOR_TRADFI = new Set(["XYZ100", "NAS100", "SP500", "GOLD", "SILVER", "CL", "BRENTOIL"]);

/** Strip a venue namespace such as "xyz:" from a coin. */
export function baseCoin(coin: string): string {
  const i = coin.indexOf(":");
  return i >= 0 ? coin.slice(i + 1) : coin;
}

/**
 * The public market list does not populate `category`, so classify from the
 * venue symbol. Hyperliquid "xyz:" markets are the TradFi/FX builder-deployed
 * perps; everything else on the listed venues is crypto.
 */
export function classifyMarket(provider: string, coin: string, category?: string | null): {
  assetClass: AssetClass;
  majorTradfi: boolean;
} {
  const cat = (category ?? "").toLowerCase();
  const base = baseCoin(coin).toUpperCase();
  if (cat) {
    if (cat.includes("forex") || cat === "fx") return { assetClass: "fx", majorTradfi: false };
    if (cat.includes("crypto")) return { assetClass: "crypto", majorTradfi: false };
    return { assetClass: "tradfi", majorTradfi: MAJOR_TRADFI.has(base) };
  }
  if (provider === "hyperliquid" && coin.startsWith("xyz:")) {
    if (FX_COINS.has(base)) return { assetClass: "fx", majorTradfi: false };
    return { assetClass: "tradfi", majorTradfi: MAJOR_TRADFI.has(base) };
  }
  return { assetClass: "crypto", majorTradfi: false };
}

/** Commission per fill, bps of fill notional. Maker and taker are the same. */
export function commissionBps(assetClass: AssetClass): number {
  switch (assetClass) {
    case "crypto":
      return 3; // 0.03%
    case "fx":
      return 0.25; // 0.0025%
    case "tradfi":
      return 0.5; // 0.005%
  }
}

/** Daily swap rate, bps of notional, charged in 24 equal hourly pieces. */
export function dailySwapBps(assetClass: AssetClass): number {
  switch (assetClass) {
    case "crypto":
      return 3;
    case "fx":
      return 0.5;
    case "tradfi":
      return 1.5;
  }
}

/**
 * Worst case number of hourly swap charges for a hold of `holdHours`:
 * a position opened just before an hourly boundary pays immediately.
 */
export function swapCharges(holdHours: number): number {
  if (!(holdHours > 0)) return 0;
  return Math.ceil(holdHours);
}

export function swapCost(notional: number, assetClass: AssetClass, holdHours: number, feeExempt = false): number {
  if (feeExempt) return 0;
  return (notional * dailySwapBps(assetClass)) / 10_000 / 24 * swapCharges(holdHours);
}

/**
 * Maximum adverse slippage cap for a market order or triggered market exit,
 * bps of the mark reference. Unknown open interest uses the most conservative
 * band, as the platform does.
 */
export function slippageCapBps(market: Pick<MarketInfo, "assetClass" | "majorTradfi">, notional: number, openInterestUsd: number | null): number {
  if (market.assetClass === "fx") {
    if (notional <= 100_000) return 0.05;
    if (notional <= 200_000) return 0.08;
    if (notional <= 1_000_000) return 0.12;
    return 0.15;
  }
  if (market.majorTradfi) {
    if (notional <= 100_000) return 0.25;
    if (notional <= 200_000) return 0.5;
    if (notional <= 1_000_000) return 0.75;
    return 1.0;
  }
  // All other instruments: OI band x notional band.
  const col = notional <= 100_000 ? 0 : notional <= 500_000 ? 1 : 2;
  const oi = openInterestUsd;
  let row: [number, number, number];
  if (oi == null || !Number.isFinite(oi)) row = [6.0, 10.0, 16.0];
  else if (oi > 500e6) row = [0.8, 1.2, 2.0];
  else if (oi >= 100e6) row = [1.2, 1.8, 3.0];
  else if (oi >= 25e6) row = [2.0, 3.0, 5.0];
  else if (oi >= 10e6) row = [3.5, 6.0, 9.0];
  else row = [6.0, 10.0, 16.0];
  return row[col];
}

/** Round a size down to the market's increment. */
export function floorToDecimals(size: number, decimals: number): number {
  const f = 10 ** decimals;
  // Guard against float dust such as 0.30000000000000004.
  return Math.floor(size * f + 1e-9) / f;
}
