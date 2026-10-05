import { describe, expect, it } from "vitest";
import { breachLines, breachPrice, feeRate, netPosition, type PositionLike } from "../src/risk/breach";

const CRYPTO_FEE = 0.0003;

describe("feeRate", () => {
  it("matches the published commission per fill", () => {
    // Crypto 0.03%, Forex 0.0025%, stocks/commodities/indices 0.005%
    expect(feeRate("crypto")).toBeCloseTo(0.0003, 10);
    expect(feeRate("fx")).toBeCloseTo(0.000025, 10);
    expect(feeRate("tradfi")).toBeCloseTo(0.00005, 10);
  });
  it("is zero for a fee-exempt policy", () => {
    for (const c of ["crypto", "fx", "tradfi"] as const) expect(feeRate(c, true)).toBe(0);
  });
});

describe("netPosition", () => {
  const L = (size: number): PositionLike => ({ side: "long", size });
  const S = (size: number): PositionLike => ({ side: "short", size });
  it("adds up one side", () => {
    expect(netPosition([L(1), L(0.5)])).toEqual({ side: "long", size: 1.5 });
  });
  it("nets opposing positions on the same market", () => {
    expect(netPosition([L(3), S(1)])).toEqual({ side: "long", size: 2 });
    expect(netPosition([L(1), S(3)])).toEqual({ side: "short", size: 2 });
  });
  it("a hedged-out market has no direction, so no line", () => {
    expect(netPosition([L(2), S(2)])).toBeNull();
  });
  it("ignores empty and non-positive sizes", () => {
    expect(netPosition([])).toBeNull();
    expect(netPosition([L(0), S(0)])).toBeNull();
    expect(netPosition([L(2), S(-5)])).toEqual({ side: "long", size: 2 });
  });
});

describe("breachPrice", () => {
  // Worked by hand: q=2, m=100, room=50, f=0.0003.
  //   long  P = (2·100 − 50) / (2 × 0.9997) = 150 / 1.9994 = 75.0225067…
  //   short P = (2·100 + 50) / (2 × 1.0003) = 250 / 2.0006 = 124.9625112…
  const base = { size: 2, mark: 100, fee: CRYPTO_FEE, room: 50 };

  it("solves the long floor", () => {
    const r = breachPrice({ ...base, side: "long" });
    expect(r.status).toBe("ok");
    expect((r as { price: number }).price).toBeCloseTo(75.0225067, 6);
  });
  it("solves the short floor", () => {
    const r = breachPrice({ ...base, side: "short" });
    expect(r.status).toBe("ok");
    expect((r as { price: number }).price).toBeCloseTo(124.9625112, 6);
  });

  // With no commission the arithmetic is exact, which pins the shape of it.
  it("fee-exempt gives the clean numbers", () => {
    expect(breachPrice({ ...base, side: "long", fee: 0 })).toEqual({ status: "ok", price: 75 });
    expect(breachPrice({ ...base, side: "short", fee: 0 })).toEqual({ status: "ok", price: 125 });
  });

  // The property that matters: at the returned price, equity has fallen by
  // exactly the room, exit fee included.
  it("the solved price loses exactly the room, exit fee included", () => {
    for (const [q, m, room, f] of [
      [2, 100, 50, CRYPTO_FEE],
      [10, 30_000, 500, 0.00005],
      [0.5, 86_220, 1200, CRYPTO_FEE],
      [100_000, 1.0825, 40, 0.000025], // one standard FX lot
    ] as const) {
      const long = breachPrice({ side: "long", size: q, mark: m, room, fee: f }) as { price: number };
      expect(q * (long.price - m) - f * q * long.price).toBeCloseTo(-room, 6);
      const short = breachPrice({ side: "short", size: q, mark: m, room, fee: f }) as { price: number };
      expect(q * (m - short.price) - f * q * short.price).toBeCloseTo(-room, 6);
    }
  });

  it("a bigger position puts the line closer to the mark", () => {
    const small = breachPrice({ ...base, side: "long", size: 1 }) as { price: number };
    const big = breachPrice({ ...base, side: "long", size: 4 }) as { price: number };
    expect(big.price).toBeGreaterThan(small.price);
    expect(big.price).toBeLessThan(base.mark);
  });

  // Floors are inclusive, so no room left is already a breach, not a line at 0.
  it("reports no room as already breached", () => {
    for (const room of [0, -0.01, -500]) {
      expect(breachPrice({ ...base, side: "long", room }).status).toBe("already-breached");
      expect(breachPrice({ ...base, side: "short", room }).status).toBe("already-breached");
    }
  });

  it("a long that cannot reach the floor even at zero is unreachable", () => {
    // max loss on the position is q·m = 100, but the room is 200
    expect(breachPrice({ side: "long", size: 1, mark: 100, room: 200, fee: CRYPTO_FEE }).status).toBe("unreachable");
  });
  it("a short can always reach its floor, since price is unbounded above", () => {
    expect(breachPrice({ side: "short", size: 1, mark: 100, room: 200, fee: CRYPTO_FEE }).status).toBe("ok");
  });

  it("has nothing to say without a position, a mark or a room", () => {
    expect(breachPrice({ ...base, side: "long", size: 0 }).status).toBe("none");
    expect(breachPrice({ ...base, side: "long", room: null }).status).toBe("none");
    expect(breachPrice({ ...base, side: "long", mark: 0 }).status).toBe("none");
    expect(breachPrice({ ...base, side: "long", room: Number.NaN }).status).toBe("none");
  });
});

describe("breachLines", () => {
  it("uses the netted position for both floors", () => {
    const r = breachLines({
      positions: [{ side: "long", size: 3 }, { side: "short", size: 1 }],
      mark: 100,
      dailyRoom: 50,
      maxDrawdownRoom: 150,
      assetClass: "crypto",
    });
    // net long 2, so the daily line matches the hand-worked long case
    expect((r.daily as { price: number }).price).toBeCloseTo(75.0225067, 6);
    // the further floor sits further away
    expect((r.maxDrawdown as { price: number }).price).toBeLessThan((r.daily as { price: number }).price);
  });
  it("gives no lines for a market that is flat or hedged out", () => {
    const r = breachLines({
      positions: [{ side: "long", size: 2 }, { side: "short", size: 2 }],
      mark: 100,
      dailyRoom: 50,
      maxDrawdownRoom: 150,
      assetClass: "crypto",
    });
    expect(r.daily.status).toBe("none");
    expect(r.maxDrawdown.status).toBe("none");
  });
  it("honours a fee-exempt policy", () => {
    const r = breachLines({
      positions: [{ side: "long", size: 2 }],
      mark: 100,
      dailyRoom: 50,
      maxDrawdownRoom: null,
      assetClass: "crypto",
      feeExempt: true,
    });
    expect(r.daily).toEqual({ status: "ok", price: 75 });
    expect(r.maxDrawdown.status).toBe("none");
  });
});
