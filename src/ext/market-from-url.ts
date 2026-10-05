/**
 * Which market is the MFP terminal showing?
 *
 * Verified against the live site on Oct 5, 2026: the terminal puts the market
 * in the path, and flags the TradFi book with a query parameter —
 *   /trade/BTC                  crypto perp
 *   /trade/NVDA?asset=tradfi    TradFi perp
 * so no DOM scraping is needed.
 *
 * The terminal's tickers are not the stream's coins, though. The terminal says
 * XAU where the stream says GOLD, and several of its TradFi names (NVDA, CL,
 * NATGAS) exist only as Binance perps rather than Hyperliquid `xyz:` ones. The
 * mapping below is explicit for that reason, and anything it cannot place
 * returns null so the panel can fall back to its own market picker rather than
 * silently charting the wrong instrument.
 */
import type { Market } from "../data/markets";

/** Terminal ticker -> the stream's symbol, where the two disagree. */
export const TERMINAL_ALIASES: Record<string, string> = {
  XAU: "GOLD",
  XAG: "SILVER",
  XPT: "PLATINUM",
  XPD: "PALLADIUM",
  BZ: "BRENTOIL",
  // the index is XYZ100 on the stream, but is written either way elsewhere
  US100: "XYZ100",
  NAS100: "XYZ100",
  SPX: "SP500",
  US500: "SP500",
};

export interface TerminalMarket {
  symbol: string;
  tradfi: boolean;
}

/** Pull the market out of a terminal URL. Null when it is not a trade page. */
export function parseTerminalUrl(href: string): TerminalMarket | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (!/(^|\.)myfundedperpetuals\.com$/i.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/trade\/([^/]+)\/?$/);
  if (!m) return null;
  const symbol = decodeURIComponent(m[1]).trim().toUpperCase();
  if (!symbol) return null;
  return { symbol, tradfi: u.searchParams.get("asset")?.toLowerCase() === "tradfi" };
}

/**
 * Resolve a terminal market against the stream's market list.
 *
 * TradFi pages prefer a Hyperliquid `xyz:` market, because that is the same
 * instrument; only if there is none do they fall back to a Binance perp of the
 * same name, which tracks the same underlying on a different venue.
 */
export function matchMarket(t: TerminalMarket | null, markets: Market[]): Market | null {
  if (!t) return null;
  const sym = (TERMINAL_ALIASES[t.symbol] ?? t.symbol).toUpperCase();
  const xyz = markets.find((m) => m.coin.toUpperCase() === `XYZ:${sym}`);
  if (t.tradfi && xyz) return xyz;
  const exact = markets.find((m) => m.symbol.toUpperCase() === sym && (!t.tradfi || m.coin.toUpperCase().startsWith("XYZ:")));
  if (exact) return exact;
  if (t.tradfi) {
    // no xyz: listing for this one (NVDA, CL, NATGAS...): the Binance perp is
    // the same underlying, so chart that rather than showing nothing
    const binance = markets.find((m) => m.symbol.toUpperCase() === sym);
    if (binance) return binance;
    return null;
  }
  return markets.find((m) => m.symbol.toUpperCase() === sym) ?? markets.find((m) => m.coin.toUpperCase() === `${sym}USDT`) ?? null;
}

/** Convenience: URL straight to a market. */
export function marketFromUrl(href: string, markets: Market[]): Market | null {
  return matchMarket(parseTerminalUrl(href), markets);
}
