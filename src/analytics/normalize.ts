import { parseUnits } from "./price";
import type { Candle, Trade } from "./types";

/** Raw wire shapes (decimal strings) from the MFP market-data stream. */
export interface WireTrade {
  type?: "trade";
  provider: string;
  symbol: string;
  tradeId: string;
  side: "buy" | "sell";
  price: string;
  size: string;
  time: number;
  receivedAt?: string;
}

export interface WireCandle {
  type?: "candle";
  provider: string;
  symbol: string;
  interval: string;
  openTime: number;
  closeTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  quoteVolume: string | null;
  trades: number | null;
  isFinal: boolean;
}

export function normTrade(w: WireTrade): Trade | null {
  if (!w || typeof w.price !== "string" || typeof w.size !== "string" || typeof w.time !== "number") return null;
  if (w.side !== "buy" && w.side !== "sell") return null;
  const sz = Number(w.size);
  if (!(sz > 0)) return null;
  return { id: String(w.tradeId), t: w.time, px: parseUnits(w.price), sz, side: w.side === "buy" ? 1 : -1 };
}

export function normCandle(w: WireCandle): Candle | null {
  if (!w || typeof w.openTime !== "number") return null;
  return {
    t: w.openTime,
    o: parseUnits(w.open),
    h: parseUnits(w.high),
    l: parseUnits(w.low),
    c: parseUnits(w.close),
    v: Number(w.volume) || 0,
  };
}
