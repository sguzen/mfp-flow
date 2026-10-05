/**
 * Risk-engine domain types, carried over from mfp-preflight's engine so the
 * two projects agree on fees, slippage caps and the daily reset rather than
 * each having their own copy of the rules. Prices are in quote currency (USD),
 * sizes in base units, timestamps Unix ms. Everything here is pure: no I/O.
 */
export type AssetClass = "crypto" | "fx" | "tradfi";

export interface MarketInfo {
  assetClass: AssetClass;
  /** Major index/commodity slippage schedule (NAS100, SP500, GOLD, SILVER, CL, BRENTOIL). */
  majorTradfi: boolean;
}

/** Adverse overshoot past a stop trigger before the fill, in basis points. */
export interface GapModel {
  typicalBps: number;
  stressBps: number;
  /** Where the numbers came from, shown to the user. */
  source: string;
  sampleSize: number;
}
