import { describe, expect, it } from "vitest";
import { binanceSymbol, parseOiHistory, periodFor } from "../src/data/binance-oi";

// Measured against the live endpoint: one 500-row page reaches 1.74d at 5m,
// 5.2d at 15m, 10.4d at 30m, 20.8d at 1h.
describe("periodFor", () => {
  it("picks the finest period that covers the window in one page", () => {
    expect(periodFor(1)).toBe("5m");
    expect(periodFor(3)).toBe("15m");
    expect(periodFor(5)).toBe("15m");
    expect(periodFor(10)).toBe("30m");
  });
  it("5m is not used beyond its 1.74-day reach", () => {
    expect(periodFor(1.7)).toBe("5m");
    expect(periodFor(2)).not.toBe("5m");
  });
  it("falls back to the coarsest period rather than asking for impossible depth", () => {
    expect(periodFor(365)).toBe("4h");
  });
  it("the app's three depths all resolve", () => {
    for (const d of [3, 5, 10]) expect(["5m", "15m", "30m", "1h", "4h"]).toContain(periodFor(d));
  });
});

describe("binanceSymbol", () => {
  it("names the symbol for a Binance perp", () => {
    expect(binanceSymbol({ provider: "binance", coin: "BTCUSDT" })).toBe("BTCUSDT");
  });
  // Hyperliquid xyz: markets have no OI history, so they must not be asked for
  it("refuses Hyperliquid markets", () => {
    expect(binanceSymbol({ provider: "hyperliquid", coin: "xyz:XYZ100" })).toBeNull();
    expect(binanceSymbol({ provider: "hyperliquid", coin: "HYPE" })).toBeNull();
  });
  it("refuses a namespaced coin even on binance", () => {
    expect(binanceSymbol({ provider: "binance", coin: "xyz:WEIRD" })).toBeNull();
  });
});

describe("parseOiHistory", () => {
  // the real response shape, as returned by the live endpoint
  const row = (t: number, usd: string) => ({
    symbol: "BTCUSDT",
    sumOpenInterest: "96921.435",
    sumOpenInterestValue: usd,
    CMCCirculatingSupply: "20093487",
    timestamp: t,
  });

  it("reads USD notional and sorts by time", () => {
    const h = parseOiHistory([row(200, "2000.5"), row(100, "1000")], "5m")!;
    expect(h.points).toEqual([
      { t: 100, usd: 1000 },
      { t: 200, usd: 2000.5 },
    ]);
    expect(h.period).toBe("5m");
    expect(h.source).toBe("binance");
  });

  it("drops unusable rows rather than zeroing them", () => {
    const h = parseOiHistory(
      [row(100, "1000"), row(200, "not-a-number"), { timestamp: 300 }, null, row(400, "0"), row(500, "-5")],
      "15m",
    )!;
    expect(h.points.map((p) => p.t)).toEqual([100]);
  });

  it("refuses a non-array body, which is how Binance reports an error", () => {
    expect(parseOiHistory({ code: -1121, msg: "Invalid symbol." }, "5m")).toBeNull();
    expect(parseOiHistory(null, "5m")).toBeNull();
  });

  it("an empty page parses to no points rather than failing", () => {
    expect(parseOiHistory([], "5m")!.points).toEqual([]);
  });
});
