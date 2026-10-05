import { describe, expect, it } from "vitest";
import { buildOverlay, exitPrice, exitsFor, type OrderLike, type PositionLike } from "../src/risk/overlay";

const MKT = "binance|BTCUSDT";
const pos = (over: Partial<PositionLike> = {}): PositionLike => ({
  id: "pos1",
  market_id: MKT,
  side: "long",
  size: 2,
  entry_price: 100,
  liquidation_price: 60,
  ...over,
});
const ord = (over: Partial<OrderLike> = {}): OrderLike => ({
  id: "o1",
  market_id: MKT,
  side: "sell",
  type: "stop_market",
  reduce_only: true,
  trigger_price: 90,
  ...over,
});

describe("exitPrice", () => {
  it("prefers the trigger, falls back to the limit", () => {
    expect(exitPrice(ord({ trigger_price: 90, limit_price: 89 }))).toBe(90);
    expect(exitPrice(ord({ trigger_price: null, limit_price: 89 }))).toBe(89);
  });
  it("ignores missing or nonsense prices", () => {
    for (const o of [{ trigger_price: null, limit_price: null }, { trigger_price: 0 }, { trigger_price: -5 }])
      expect(exitPrice(ord(o as Partial<OrderLike>))).toBeNull();
  });
});

describe("exitsFor", () => {
  it("finds a reduce-only stop and take on the same market", () => {
    const e = exitsFor(pos(), [ord(), ord({ id: "o2", type: "take_profit", trigger_price: 120 })]);
    expect(e).toEqual({ stop: 90, target: 120 });
  });
  it("accepts every stop and take order type", () => {
    for (const t of ["stop_market", "stop_limit"]) expect(exitsFor(pos(), [ord({ type: t })]).stop).toBe(90);
    for (const t of ["take_market", "take_limit", "take_profit"])
      expect(exitsFor(pos(), [ord({ type: t, trigger_price: 120 })]).target).toBe(120);
  });
  it("ignores orders that are not protective", () => {
    // not reduce-only, wrong market, or pointing the same way as the position
    expect(exitsFor(pos(), [ord({ reduce_only: false })]).stop).toBeNull();
    expect(exitsFor(pos(), [ord({ market_id: "binance|ETHUSDT" })]).stop).toBeNull();
    expect(exitsFor(pos(), [ord({ side: "buy" })]).stop).toBeNull();
  });
  it("reads a short's exits the other way round", () => {
    const p = pos({ side: "short", entry_price: 100 });
    const e = exitsFor(p, [ord({ side: "buy", trigger_price: 110 }), ord({ id: "o2", side: "buy", type: "take_profit", trigger_price: 80 })]);
    expect(e).toEqual({ stop: 110, target: 80 });
  });

  // target_position_id is what keeps a hedged market honest
  it("uses target_position_id when the API sets it", () => {
    const p = pos({ id: "A" });
    const mine = ord({ id: "oA", target_position_id: "A", trigger_price: 95 });
    const theirs = ord({ id: "oB", target_position_id: "B", trigger_price: 80 });
    expect(exitsFor(p, [mine, theirs]).stop).toBe(95);
  });
  it("will not hand an untagged order to a position when tagged ones exist", () => {
    const p = pos({ id: "A" });
    const tagged = ord({ id: "oA", target_position_id: "A", trigger_price: 95 });
    const loose = ord({ id: "oX", trigger_price: 50 });
    expect(exitsFor(p, [tagged, loose]).stop).toBe(95);
  });
  it("ignores orders tagged to another position when falling back", () => {
    const p = pos({ id: "A" });
    expect(exitsFor(p, [ord({ id: "oB", target_position_id: "B", trigger_price: 80 })]).stop).toBeNull();
  });

  // several stops: the nearest one is what actually protects a long
  it("takes the tightest stop and the nearest target", () => {
    const e = exitsFor(pos(), [
      ord({ id: "s1", trigger_price: 80 }),
      ord({ id: "s2", trigger_price: 92 }),
      ord({ id: "t1", type: "take_profit", trigger_price: 130 }),
      ord({ id: "t2", type: "take_profit", trigger_price: 115 }),
    ]);
    expect(e).toEqual({ stop: 92, target: 115 });
  });
});

describe("buildOverlay", () => {
  const base = {
    marketId: MKT,
    mark: 100,
    dailyRoom: 50,
    maxDrawdownRoom: 150,
    assetClass: "crypto" as const,
    feeExempt: true,
  };

  it("draws entry, stop, target, liquidation and both floors", () => {
    const o = buildOverlay({ ...base, positions: [pos()], orders: [ord(), ord({ id: "t", type: "take_profit", trigger_price: 120 })] });
    expect(o.lines.map((l) => l.kind)).toEqual(["entry", "stop", "target", "liquidation", "daily-breach", "drawdown-breach"]);
    // fee-exempt long, q=2, m=100: daily (200-50)/2 = 75, drawdown (200-150)/2 = 25
    expect(o.lines.find((l) => l.kind === "daily-breach")!.price).toBe(75);
    expect(o.lines.find((l) => l.kind === "drawdown-breach")!.price).toBe(25);
  });

  it("ignores positions on other markets", () => {
    const o = buildOverlay({ ...base, positions: [pos({ market_id: "binance|ETHUSDT" })], orders: [] });
    expect(o.positions).toHaveLength(0);
    expect(o.lines).toHaveLength(0);
    expect(o.daily.status).toBe("none");
  });

  it("shows no breach line when there is no position, even with room", () => {
    const o = buildOverlay({ ...base, positions: [], orders: [] });
    expect(o.lines).toHaveLength(0);
    expect(o.daily.status).toBe("none");
  });

  it("nets two positions on the same market into one pair of floors", () => {
    const o = buildOverlay({
      ...base,
      positions: [pos({ id: "a", size: 3 }), pos({ id: "b", side: "short", size: 1, liquidation_price: null })],
      orders: [],
    });
    // net long 2 -> the same floors as the single 2-lot case
    expect(o.lines.filter((l) => l.kind === "daily-breach")).toHaveLength(1);
    expect(o.lines.find((l) => l.kind === "daily-breach")!.price).toBe(75);
    // but both entries are still drawn
    expect(o.lines.filter((l) => l.kind === "entry")).toHaveLength(2);
  });

  it("says already breached rather than drawing a line", () => {
    const o = buildOverlay({ ...base, positions: [pos()], orders: [], dailyRoom: 0 });
    expect(o.daily.status).toBe("already-breached");
    expect(o.lines.some((l) => l.kind === "daily-breach")).toBe(false);
  });

  it("omits a liquidation line the API did not give", () => {
    const o = buildOverlay({ ...base, positions: [pos({ liquidation_price: null })], orders: [] });
    expect(o.lines.some((l) => l.kind === "liquidation")).toBe(false);
  });

  it("labels lines with the formatted price", () => {
    const o = buildOverlay({ ...base, positions: [pos()], orders: [], fmt: (n) => n.toFixed(2) });
    expect(o.lines[0].label).toBe("Long entry 100.00");
    expect(o.lines.find((l) => l.kind === "daily-breach")!.label).toBe("Daily loss floor 75.00");
  });
});
