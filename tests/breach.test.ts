import { describe, expect, it } from "vitest";
import { breachLines, breachPrice, exitCost, feeRate, netPosition, type PositionLike } from "../src/risk/breach";

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
  // Equity is balance plus unrealised PnL, so the floor is reached after a move
  // of room/size: q=2, m=100, room=50 -> 25 of price.
  const base = { size: 2, mark: 100, room: 50 };

  it("solves the long floor", () => {
    expect(breachPrice({ ...base, side: "long" })).toEqual({ status: "ok", price: 75 });
  });
  it("solves the short floor", () => {
    expect(breachPrice({ ...base, side: "short" })).toEqual({ status: "ok", price: 125 });
  });

  // The real check: MFP's own terminal showed Loss Limit 124.61 on this
  // position, which is what the line has to agree with.
  it("agrees with MFP's displayed Loss Limit on a real position", () => {
    const r = breachPrice({ side: "short", size: 1035.11, mark: 120.772, room: 3968 }) as { price: number };
    expect(r.price).toBeCloseTo(124.6055, 3);
    expect(Number(r.price.toFixed(2))).toBe(124.61);
  });

  it("the solved price loses exactly the room", () => {
    for (const [q, m, room] of [
      [2, 100, 50],
      [10, 30_000, 500],
      [1035.11, 120.772, 3968],
      [100_000, 1.0825, 40],
    ] as const) {
      const long = breachPrice({ side: "long", size: q, mark: m, room }) as { price: number };
      expect(q * (long.price - m)).toBeCloseTo(-room, 6);
      const short = breachPrice({ side: "short", size: q, mark: m, room }) as { price: number };
      expect(q * (m - short.price)).toBeCloseTo(-room, 6);
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
    expect(breachPrice({ side: "long", size: 1, mark: 100, room: 200 }).status).toBe("unreachable");
  });
  it("a short can always reach its floor, since price is unbounded above", () => {
    expect(breachPrice({ side: "short", size: 1, mark: 100, room: 200 }).status).toBe("ok");
  });

  it("has nothing to say without a position, a mark or a room", () => {
    expect(breachPrice({ ...base, side: "long", size: 0 }).status).toBe("none");
    expect(breachPrice({ ...base, side: "long", room: null }).status).toBe("none");
    expect(breachPrice({ ...base, side: "long", mark: 0 }).status).toBe("none");
    expect(breachPrice({ ...base, side: "long", room: Number.NaN }).status).toBe("none");
  });
});

describe("exitCost", () => {
  // Not drawn, but it is what the commission cushion is worth knowing as.
  it("sits inside the breach line, by the commission", () => {
    const breach = (breachPrice({ side: "short", size: 1035.11, mark: 120.772, room: 3968 }) as { price: number }).price;
    const exit = exitCost({ side: "short", size: 1035.11, mark: 120.772, room: 3968, fee: 0.0003 })!;
    expect(exit).toBeLessThan(breach);
    expect(breach - exit).toBeCloseTo(0.0374, 3);
  });
  it("equals the breach line when there is no commission", () => {
    const b = (breachPrice({ side: "long", size: 2, mark: 100, room: 50 }) as { price: number }).price;
    expect(exitCost({ side: "long", size: 2, mark: 100, room: 50, fee: 0 })).toBeCloseTo(b, 10);
  });
  it("has nothing to say without a position", () => {
    expect(exitCost({ side: "long", size: 0, mark: 100, room: 50, fee: 0.0003 })).toBeNull();
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
    // net long 2: daily 100 - 25 = 75, drawdown 100 - 75 = 25
    expect(r.daily).toEqual({ status: "ok", price: 75 });
    expect(r.maxDrawdown).toEqual({ status: "ok", price: 25 });
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
  it("is unaffected by the fee policy, which no longer moves the line", () => {
    const of = (feeExempt: boolean) =>
      breachLines({ positions: [{ side: "long", size: 2 }], mark: 100, dailyRoom: 50, maxDrawdownRoom: null, assetClass: "crypto", feeExempt });
    expect(of(true).daily).toEqual(of(false).daily);
    expect(of(true).daily).toEqual({ status: "ok", price: 75 });
  });
});
