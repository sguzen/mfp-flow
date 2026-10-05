import { describe, expect, it } from "vitest";
import { barOi, carryForward, classifyOi, OI_DEAD_ZONE } from "../src/analytics/oi";

/** 1,000,000 of OI makes the 0.1% dead zone exactly 1,000. */
const base = { oiOpen: 1_000_000, priceOpen: 100, priceClose: 101 };

describe("the four readings", () => {
  it("price up, OI up -> new longs", () => {
    const r = classifyOi({ ...base, oiClose: 1_010_000 })!;
    expect(r.regime).toBe("new-longs");
    expect(r.label).toBe("new longs");
    expect(r.deltaOi).toBe(10_000);
    expect(r.deltaOiPct).toBeCloseTo(0.01, 10);
  });
  it("price up, OI down -> short covering", () => {
    expect(classifyOi({ ...base, oiClose: 990_000 })!.regime).toBe("short-covering");
  });
  it("price down, OI up -> new shorts", () => {
    expect(classifyOi({ ...base, priceClose: 99, oiClose: 1_010_000 })!.regime).toBe("new-shorts");
  });
  it("price down, OI down -> long liquidation", () => {
    expect(classifyOi({ ...base, priceClose: 99, oiClose: 990_000 })!.regime).toBe("long-liquidation");
  });
});

describe("initiative buying", () => {
  it("new longs with buying delta reads as initiative buying", () => {
    expect(classifyOi({ ...base, oiClose: 1_010_000, delta: 25 })!.label).toBe("initiative buying");
  });
  it("new longs with selling or absent delta stays new longs", () => {
    for (const delta of [-25, 0, null, undefined])
      expect(classifyOi({ ...base, oiClose: 1_010_000, delta })!.label).toBe("new longs");
  });
  // the upgrade belongs to new longs only; the other three keep their names
  it("does not relabel the other regimes", () => {
    expect(classifyOi({ ...base, oiClose: 990_000, delta: 25 })!.label).toBe("short covering");
    expect(classifyOi({ ...base, priceClose: 99, oiClose: 1_010_000, delta: -25 })!.label).toBe("new shorts");
    expect(classifyOi({ ...base, priceClose: 99, oiClose: 990_000, delta: -25 })!.label).toBe("long liquidation");
  });
});

describe("dead zone", () => {
  // 0.1% of 1,000,000 is 1,000 exactly
  it("a change below 0.1% of OI is flat, either way", () => {
    expect(classifyOi({ ...base, oiClose: 1_000_999 })!.regime).toBe("flat");
    expect(classifyOi({ ...base, oiClose: 999_001 })!.regime).toBe("flat");
  });
  it("exactly 0.1% is outside the dead zone and classifies", () => {
    expect(classifyOi({ ...base, oiClose: 1_001_000 })!.regime).toBe("new-longs");
    expect(classifyOi({ ...base, oiClose: 999_000 })!.regime).toBe("short-covering");
  });
  it("still reports the measured change while calling it flat", () => {
    const r = classifyOi({ ...base, oiClose: 1_000_500 })!;
    expect(r.regime).toBe("flat");
    expect(r.deltaOi).toBe(500);
  });
  it("honours a custom threshold", () => {
    expect(classifyOi({ ...base, oiClose: 1_010_000, deadZone: 0.05 })!.regime).toBe("flat");
  });
  it("the default threshold is 0.1%", () => {
    expect(OI_DEAD_ZONE).toBe(0.001);
  });
});

describe("refusing to invent a reading", () => {
  // blank, not zero: a bar with no OI must not look like a bar with no change
  it("returns null when either end of the OI is unknown", () => {
    expect(classifyOi({ ...base, oiOpen: null, oiClose: 1_010_000 })).toBeNull();
    expect(classifyOi({ ...base, oiClose: null })).toBeNull();
    expect(classifyOi({ ...base, oiOpen: Number.NaN, oiClose: 1 })).toBeNull();
  });
  it("an unchanged price has no direction, so it is flat", () => {
    expect(classifyOi({ ...base, priceClose: 100, oiClose: 1_500_000 })!.regime).toBe("flat");
  });
  it("survives an opening OI of zero without dividing by it", () => {
    const r = classifyOi({ oiOpen: 0, oiClose: 5000, priceOpen: 100, priceClose: 101 })!;
    expect(r.deltaOiPct).toBe(0);
    expect(r.regime).toBe("flat");
  });
});

describe("carryForward", () => {
  it("holds the last observation across unsampled minutes", () => {
    const s = new Map([[2, 100], [5, 120]]);
    expect(carryForward(s, [1, 2, 3, 4, 5, 6])).toEqual([null, 100, 100, 100, 120, 120]);
  });
  // OI is a level: before the first sample it is unknown, not zero
  it("leaves minutes before the first sample unknown", () => {
    expect(carryForward(new Map([[3, 10]]), [1, 2, 3])).toEqual([null, null, 10]);
  });
  it("ignores non-finite samples", () => {
    expect(carryForward(new Map([[1, Number.NaN], [2, 7]]), [1, 2])).toEqual([null, 7]);
  });
  it("is all-null with no samples at all", () => {
    expect(carryForward(new Map(), [1, 2, 3])).toEqual([null, null, null]);
  });
});

describe("barOi", () => {
  const series = [null, 100, 110, null, 130, null];
  it("takes the first and last known values inside the bar", () => {
    expect(barOi(series, 1, 4)).toEqual({ open: 100, close: 130 });
  });
  it("skips the gaps at either end", () => {
    expect(barOi(series, 0, 2)).toEqual({ open: 100, close: 110 });
    expect(barOi(series, 3, 5)).toEqual({ open: 130, close: 130 });
  });
  it("is unknown when the bar has no samples", () => {
    expect(barOi([null, null], 0, 1)).toEqual({ open: null, close: null });
  });
  it("does not run past the end of the series", () => {
    expect(barOi(series, 4, 99)).toEqual({ open: 130, close: 130 });
  });
});
