import { describe, expect, it } from "vitest";
import { embedHash, isMarketMessage, parseEmbed } from "../src/ext/embed";

describe("parseEmbed", () => {
  it("reads the embed flag, ticker and TradFi marker", () => {
    expect(parseEmbed("#embed=1&sym=XAU&tradfi=1")).toEqual({ embed: true, symbol: "XAU", tradfi: true });
  });
  it("upper-cases the ticker", () => {
    expect(parseEmbed("#embed=1&sym=btc").symbol).toBe("BTC");
  });
  it("is not embedded without the flag", () => {
    expect(parseEmbed("#sym=BTC").embed).toBe(false);
    expect(parseEmbed("")).toEqual({ embed: false, symbol: null, tradfi: false });
  });
  it("treats a missing or blank ticker as none", () => {
    expect(parseEmbed("#embed=1").symbol).toBeNull();
    expect(parseEmbed("#embed=1&sym=").symbol).toBeNull();
  });
  it("only counts tradfi=1 as TradFi", () => {
    expect(parseEmbed("#embed=1&sym=BTC&tradfi=0").tradfi).toBe(false);
  });
  it("round-trips through embedHash", () => {
    for (const [sym, tradfi] of [["BTC", false], ["XAU", true], [null, false]] as const)
      expect(parseEmbed(embedHash(sym, tradfi))).toEqual({ embed: true, symbol: sym, tradfi });
  });
  it("ignores a share link's keys", () => {
    // a normal chart link must not look like an embed
    expect(parseEmbed("#m=binance|BTCUSDT&v=tpo&tf=30").embed).toBe(false);
  });
});

describe("isMarketMessage", () => {
  it("accepts the panel's own message", () => {
    expect(isMarketMessage({ source: "mfp-flow", type: "market", symbol: "BTC", tradfi: false })).toBe(true);
    expect(isMarketMessage({ source: "mfp-flow", type: "market", symbol: null, tradfi: false })).toBe(true);
  });
  // the panel is an iframe on a third-party page: anything can postMessage to it
  it("rejects anything else", () => {
    for (const bad of [
      null,
      undefined,
      "market",
      42,
      {},
      { type: "market", symbol: "BTC" },
      { source: "someone-else", type: "market", symbol: "BTC" },
      { source: "mfp-flow", type: "setKey", symbol: "BTC" },
      { source: "mfp-flow", type: "market", symbol: 42 },
    ])
      expect(isMarketMessage(bad), JSON.stringify(bad)).toBe(false);
  });
});
