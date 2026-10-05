import { describe, expect, it } from "vitest";
import { LIQ_CAVEAT, LiquidationFeed, NO_LIQ_FEED, parseForceOrder } from "../src/data/liquidations";

const U = 100_000_000;
/** The documented forceOrder payload shape. */
const evt = (over: Record<string, unknown> = {}) => ({
  e: "forceOrder",
  E: 1_568_014_460_000,
  o: { s: "BTCUSDT", S: "SELL", o: "LIMIT", f: "IOC", q: "0.014", p: "9910", ap: "9910", X: "FILLED", l: "0.014", z: "0.014", T: 1_568_014_460_893, ...over },
});

describe("parseForceOrder", () => {
  it("reads a liquidation", () => {
    expect(parseForceOrder(evt())).toEqual({
      t: 1_568_014_460_893,
      price: 9910 * U,
      qty: 0.014,
      notional: 0.014 * 9910,
      side: "long",
    });
  });

  // the side is what the exchange traded to close someone, not their direction
  it("a SELL closes a long, a BUY closes a short", () => {
    expect(parseForceOrder(evt())!.side).toBe("long");
    expect(parseForceOrder(evt({ S: "BUY" }))!.side).toBe("short");
    expect(parseForceOrder(evt({ S: "sell" }))!.side).toBe("long");
  });

  it("prefers the average fill price over the order price", () => {
    expect(parseForceOrder(evt({ ap: "9900", p: "9910" }))!.price).toBe(9900 * U);
  });
  it("falls back to the order price when there is no average", () => {
    expect(parseForceOrder(evt({ ap: undefined }))!.price).toBe(9910 * U);
  });
  it("uses the filled quantity", () => {
    expect(parseForceOrder(evt({ z: "0.5", q: "1.0" }))!.qty).toBe(0.5);
  });
  it("falls back to the event time when the order has none", () => {
    expect(parseForceOrder(evt({ T: undefined }))!.t).toBe(1_568_014_460_000);
  });

  describe("refuses anything it cannot trust", () => {
    it("other event types", () => {
      expect(parseForceOrder({ e: "trade", o: {} })).toBeNull();
      expect(parseForceOrder({ e: "forceOrder" })).toBeNull();
    });
    it("non-objects", () => {
      for (const bad of [null, undefined, "forceOrder", 7, []]) expect(parseForceOrder(bad)).toBeNull();
    });
    it("an unusable side, price or quantity", () => {
      expect(parseForceOrder(evt({ S: "NEITHER" }))).toBeNull();
      expect(parseForceOrder(evt({ ap: "nope", p: "nope" }))).toBeNull();
      expect(parseForceOrder(evt({ ap: "0", p: "0" }))).toBeNull();
      expect(parseForceOrder(evt({ z: "0", q: "0" }))).toBeNull();
      expect(parseForceOrder(evt({ z: "-1", q: "-1" }))).toBeNull();
    });
  });
});

describe("the caveats are stated, not implied", () => {
  it("says the feed is sampled and undercounts", () => {
    expect(LIQ_CAVEAT).toContain("sampled");
    expect(LIQ_CAVEAT).toContain("undercounts cascades");
  });
  it("says plainly when a venue has no feed", () => {
    expect(NO_LIQ_FEED).toBe("no public liquidation feed for this venue");
  });
});

describe("LiquidationFeed.restore", () => {
  // inside the keep window, or prune would correctly discard them
  const NOW = Date.now();
  const liq = (ago: number, qty = 1) => ({ t: NOW - ago, price: 100 * U, qty, notional: qty * 100, side: "long" as const });

  it("merges stored items in time order", () => {
    const f = new LiquidationFeed("BTCUSDT");
    f.restore([liq(1000), liq(3000), liq(2000)]);
    expect(f.items.map((l) => l.t)).toEqual([NOW - 3000, NOW - 2000, NOW - 1000]);
  });
  it("does not duplicate an item it already has", () => {
    const f = new LiquidationFeed("BTCUSDT");
    f.restore([liq(3000)]);
    f.restore([liq(3000), liq(2000)]);
    expect(f.items.map((l) => l.t)).toEqual([NOW - 3000, NOW - 2000]);
  });
  it("treats same-time items of different size as distinct", () => {
    const f = new LiquidationFeed("BTCUSDT");
    f.restore([liq(3000, 1), liq(3000, 2)]);
    expect(f.items).toHaveLength(2);
  });
  it("drops anything past the keep window", () => {
    const f = new LiquidationFeed("BTCUSDT", { keepMs: 1000 });
    f.restore([liq(10_000), liq(0)]);
    expect(f.items).toHaveLength(1);
  });
  it("starts idle, so the UI never implies a feed that is not connected", () => {
    expect(new LiquidationFeed("BTCUSDT").state).toBe("idle");
  });
});
