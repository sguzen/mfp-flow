import { describe, expect, it } from "vitest";
import type { Market } from "../src/data/markets";
import { marketFromUrl, matchMarket, parseTerminalUrl } from "../src/ext/market-from-url";

// a slice of the real market list, with the shapes that actually matter:
// an xyz: TradFi perp, a Binance perp of the same underlying, and plain crypto
const mk = (market_id: string, symbol: string, coin: string, provider: string): Market => ({
  market_id,
  provider,
  symbol,
  coin,
  size_decimals: 3,
});
const MARKETS: Market[] = [
  mk("binance|BTCUSDT", "BTC", "BTCUSDT", "binance"),
  mk("binance|ETHUSDT", "ETH", "ETHUSDT", "binance"),
  mk("hyperliquid|xyz:GOLD", "GOLD", "xyz:GOLD", "hyperliquid"),
  mk("hyperliquid|xyz:SILVER", "SILVER", "xyz:SILVER", "hyperliquid"),
  mk("hyperliquid|xyz:XYZ100", "XYZ100", "xyz:XYZ100", "hyperliquid"),
  mk("hyperliquid|xyz:AAPL", "AAPL", "xyz:AAPL", "hyperliquid"),
  mk("binance|NVDAUSDT", "NVDA", "NVDAUSDT", "binance"),
  mk("binance|AAPLUSDT", "AAPL", "AAPLUSDT", "binance"),
];

describe("parseTerminalUrl", () => {
  it("reads a crypto trade page", () => {
    expect(parseTerminalUrl("https://myfundedperpetuals.com/trade/BTC")).toEqual({ symbol: "BTC", tradfi: false });
  });
  it("reads a TradFi trade page", () => {
    expect(parseTerminalUrl("https://myfundedperpetuals.com/trade/NVDA?asset=tradfi")).toEqual({ symbol: "NVDA", tradfi: true });
  });
  it("upper-cases the ticker and tolerates a trailing slash", () => {
    expect(parseTerminalUrl("https://myfundedperpetuals.com/trade/btc/")).toEqual({ symbol: "BTC", tradfi: false });
  });
  it("keeps other query parameters out of the way", () => {
    expect(parseTerminalUrl("https://myfundedperpetuals.com/trade/XAU?asset=tradfi&tf=5")).toEqual({ symbol: "XAU", tradfi: true });
  });
  it("ignores pages that are not the terminal", () => {
    for (const u of [
      "https://myfundedperpetuals.com/",
      "https://myfundedperpetuals.com/auth/sign-in",
      "https://myfundedperpetuals.com/trade",
      "https://myfundedperpetuals.com/trade/BTC/extra",
    ])
      expect(parseTerminalUrl(u), u).toBeNull();
  });
  it("ignores other hosts, including look-alikes", () => {
    expect(parseTerminalUrl("https://evil.com/trade/BTC")).toBeNull();
    expect(parseTerminalUrl("https://myfundedperpetuals.com.evil.com/trade/BTC")).toBeNull();
  });
  it("accepts subdomains of the real host", () => {
    expect(parseTerminalUrl("https://app.myfundedperpetuals.com/trade/BTC")?.symbol).toBe("BTC");
  });
  it("survives a malformed URL", () => {
    expect(parseTerminalUrl("not a url")).toBeNull();
  });
});

describe("matchMarket", () => {
  it("maps a crypto ticker to its Binance perp", () => {
    expect(marketFromUrl("https://myfundedperpetuals.com/trade/BTC", MARKETS)?.market_id).toBe("binance|BTCUSDT");
  });

  // the terminal's metals tickers are not the stream's names
  it("maps XAU to GOLD and XAG to SILVER", () => {
    expect(marketFromUrl("https://myfundedperpetuals.com/trade/XAU?asset=tradfi", MARKETS)?.market_id).toBe("hyperliquid|xyz:GOLD");
    expect(marketFromUrl("https://myfundedperpetuals.com/trade/XAG?asset=tradfi", MARKETS)?.market_id).toBe("hyperliquid|xyz:SILVER");
  });
  it("maps the index aliases to XYZ100", () => {
    for (const s of ["US100", "NAS100"])
      expect(marketFromUrl(`https://myfundedperpetuals.com/trade/${s}?asset=tradfi`, MARKETS)?.market_id).toBe("hyperliquid|xyz:XYZ100");
  });

  it("prefers the xyz: listing for a TradFi page when both venues have it", () => {
    expect(marketFromUrl("https://myfundedperpetuals.com/trade/AAPL?asset=tradfi", MARKETS)?.market_id).toBe("hyperliquid|xyz:AAPL");
  });
  it("falls back to the Binance perp when there is no xyz: listing", () => {
    // NVDA is on the TradFi book but has no xyz: market on the stream
    expect(marketFromUrl("https://myfundedperpetuals.com/trade/NVDA?asset=tradfi", MARKETS)?.market_id).toBe("binance|NVDAUSDT");
  });
  it("does not hand a TradFi page a crypto market of the same name by accident", () => {
    const onlyCrypto = MARKETS.filter((m) => !m.coin.startsWith("xyz:"));
    // with no xyz:AAPL present the Binance one is the honest answer, and it is
    // chosen deliberately rather than by the generic symbol path
    expect(matchMarket({ symbol: "AAPL", tradfi: true }, onlyCrypto)?.market_id).toBe("binance|AAPLUSDT");
  });
  it("returns null when nothing matches, so the panel can ask", () => {
    expect(marketFromUrl("https://myfundedperpetuals.com/trade/DOESNOTEXIST", MARKETS)).toBeNull();
    expect(matchMarket(null, MARKETS)).toBeNull();
  });
  it("resolves a coin-suffixed crypto ticker", () => {
    expect(matchMarket({ symbol: "ETH", tradfi: false }, MARKETS)?.market_id).toBe("binance|ETHUSDT");
  });
});
