import { describe, expect, it } from "vitest";
import { parseLink, serializeLink, type LinkState } from "../src/link";

const FULL: LinkState = {
  market: "hyperliquid|xyz:XYZ100",
  view: "tpo",
  tf: 30,
  days: 10,
  rightProfile: "composite",
  row: 25,
  session: "ny18",
};
const FULL_HASH = "m=hyperliquid|xyz:XYZ100&v=tpo&tf=30&d=10&r=composite&row=25&s=ny18";

describe("serializeLink", () => {
  it("writes the documented form", () => {
    expect(serializeLink(FULL)).toBe(FULL_HASH);
  });
  it("omits absent fields", () => {
    expect(serializeLink({ market: "binance|BTCUSDT", view: "footprint" })).toBe("m=binance|BTCUSDT&v=footprint");
  });
  it("writes small row sizes in full, never as an exponent", () => {
    expect(serializeLink({ row: 0.00000001 })).toBe("row=0.00000001");
    expect(serializeLink({ row: 0.5 })).toBe("row=0.5");
    expect(serializeLink({ row: 1000 })).toBe("row=1000");
  });
});

describe("parseLink", () => {
  it("reads the documented form", () => {
    expect(parseLink("#" + FULL_HASH)).toEqual(FULL);
  });
  it("works with or without the leading hash", () => {
    expect(parseLink(FULL_HASH)).toEqual(FULL);
  });
  it("accepts a percent-encoded market", () => {
    expect(parseLink("#m=hyperliquid%7Cxyz%3AXYZ100").market).toBe("hyperliquid|xyz:XYZ100");
  });
  it("empty hash gives empty state", () => {
    expect(parseLink("")).toEqual({});
    expect(parseLink("#")).toEqual({});
  });

  describe("legacy forms still resolve", () => {
    it("bare alias", () => {
      expect(parseLink("#XYZ100")).toEqual({ market: "XYZ100" });
    });
    it("bare symbol", () => {
      expect(parseLink("#BTCUSDT")).toEqual({ market: "BTCUSDT" });
    });
    it("provider-qualified id", () => {
      expect(parseLink("#binance|BTCUSDT")).toEqual({ market: "binance|BTCUSDT" });
    });
    it("percent-encoded legacy id", () => {
      expect(parseLink("#hyperliquid%7Cxyz%3AXYZ100")).toEqual({ market: "hyperliquid|xyz:XYZ100" });
    });
  });

  describe("bad input degrades instead of throwing", () => {
    it("drops an unknown view but keeps the rest", () => {
      expect(parseLink("#m=BTCUSDT&v=candles&tf=5")).toEqual({ market: "BTCUSDT", tf: 5 });
    });
    it("drops an off-list timeframe and day count", () => {
      expect(parseLink("#tf=7&d=4")).toEqual({});
    });
    it("drops a non-positive row", () => {
      expect(parseLink("#row=0")).toEqual({});
      expect(parseLink("#row=-5")).toEqual({});
      expect(parseLink("#row=abc")).toEqual({});
    });
    it("ignores unknown keys and empty values", () => {
      expect(parseLink("#zz=1&m=&v=tpo")).toEqual({ view: "tpo" });
    });
    it("survives a malformed escape", () => {
      expect(parseLink("#m=%E0%A4%A")).toEqual({ market: "%E0%A4%A" });
    });
  });
});

describe("round trip", () => {
  it("hash -> state -> hash is stable", () => {
    expect(serializeLink(parseLink("#" + FULL_HASH))).toBe(FULL_HASH);
  });
  it("state -> hash -> state is stable", () => {
    expect(parseLink("#" + serializeLink(FULL))).toEqual(FULL);
  });
  it("every view, timeframe, day count and session survives the trip", () => {
    for (const view of ["footprint", "profiles", "tpo"] as const)
      for (const tf of [1, 5, 15, 30])
        for (const days of [3, 5, 10])
          for (const session of ["utc", "ny18"] as const) {
            const s: LinkState = { market: "binance|BTCUSDT", view, tf, days, session };
            expect(parseLink("#" + serializeLink(s))).toEqual(s);
          }
  });
  it("a legacy link serialises into the new form", () => {
    expect(serializeLink(parseLink("#XYZ100"))).toBe("m=XYZ100");
  });
});
