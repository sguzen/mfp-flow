import { describe, expect, it } from "vitest";
import { cvdDivergences, failedAuctions, locationVsValue, lowVolumeNodes, nakedPocs, poorExtremes, singlePrints, valueRelation } from "../src/analytics/auction";
import { profileFromVolumes } from "../src/analytics/profile";
import type { Bar } from "../src/analytics/types";

function bar(i: number, o: number, h: number, l: number, c: number, delta = 0): Bar {
  return {
    t: i * 60_000,
    dur: 60_000,
    o,
    h,
    l,
    c,
    vol: 1,
    buy: Math.max(0, delta),
    sell: Math.max(0, -delta),
    estVol: 0,
    realDelta: delta,
    estDelta: 0,
    realMinutes: 1,
    minutes: 1,
    cells: new Map(),
    session: 0,
  };
}

describe("low-volume nodes", () => {
  it("finds thin interior runs, ignores the edges", () => {
    // mean of non-zero = (1+50+60+2+1+70+40+1)/8 = 28.125, thr 15% = 4.22
    const p = profileFromVolumes({ 1: 1, 2: 50, 3: 60, 4: 2, 5: 1, 6: 70, 7: 40, 8: 1 });
    expect(lowVolumeNodes(p, 0.15)).toEqual([{ from: 4, to: 5 }]);
  });
});

describe("single prints", () => {
  it("rows touched by exactly one bar (excluding extremes)", () => {
    const bars = [bar(0, 10, 12, 10, 12), bar(1, 12, 20, 12, 20), bar(2, 20, 22, 19, 21)];
    // rows (size 1): bar0 10..12, bar1 12..20, bar2 19..22; rows 13..18 touched once
    expect(singlePrints(bars, 1, 2)).toEqual([{ from: 13, to: 18 }]);
  });
});

describe("poor highs / lows", () => {
  it("flags extremes without a tail", () => {
    // top row 9 has 40 (mean ~33) -> poor high; bottom has a 3-row thin tail -> fine
    const p = profileFromVolumes({ 1: 1, 2: 2, 3: 3, 4: 40, 5: 60, 6: 80, 7: 50, 8: 45, 9: 40 });
    const r = poorExtremes(p);
    expect(r.map((x) => x.kind)).toEqual(["poor-high"]);
    expect(r[0].row).toBe(9);
  });
  it("one thin row is not enough excess", () => {
    const p = profileFromVolumes({ 1: 1, 2: 40, 3: 60, 4: 80, 5: 50, 6: 45, 7: 1, 8: 1 });
    expect(poorExtremes(p, { minTail: 2 }).map((x) => x.kind)).toEqual(["poor-low"]);
  });
});

describe("failed auction", () => {
  const refs = [{ label: "pVAH", price: 100, dir: 1 as const }];
  it("break above, close back inside; reports excursion delta support", () => {
    const bars = [bar(0, 95, 99, 94, 98, 5), bar(1, 98, 103, 97, 102, 10), bar(2, 102, 104, 101, 103, -3), bar(3, 103, 103, 97, 98, -20)];
    const fa = failedAuctions(bars, 0, 3, refs, (i) => bars[i].realDelta, () => true);
    expect(fa.length).toBe(1);
    expect(fa[0]).toMatchObject({ breakIdx: 1, backIdx: 3, extreme: 104, excursionDelta: -13, supported: false, deltaQuality: "real" });
  });
  it("no failure while price holds outside", () => {
    const bars = [bar(0, 95, 99, 94, 98), bar(1, 98, 103, 97, 102), bar(2, 102, 104, 101, 103)];
    expect(failedAuctions(bars, 0, 2, refs, () => 0, () => true)).toEqual([]);
  });
  it("low side mirror with estimated delta", () => {
    const low = [{ label: "pVAL", price: 50, dir: -1 as const }];
    const bars = [bar(0, 55, 56, 49, 51, -4)];
    const fa = failedAuctions(bars, 0, 0, low, (i) => bars[i].realDelta, () => false);
    expect(fa[0]).toMatchObject({ breakIdx: 0, backIdx: 0, extreme: 49, supported: true, deltaQuality: "estimated" });
  });
});

describe("naked POCs", () => {
  it("POCs not revisited by later bars", () => {
    const bars = [bar(0, 10, 12, 9, 11), bar(1, 11, 13, 10, 12), bar(2, 20, 22, 19, 21), bar(3, 21, 25, 20, 24)];
    // rowUnits 1: session A poc 10 (bars 0..1), session B poc 21 (bars 2..3)
    const sess = [
      { start: 0, poc: 10, i1: 1 },
      { start: 1, poc: 21, i1: 3 },
    ];
    expect(nakedPocs(sess, bars, 1)).toEqual([{ session: 0, row: 10 }]);
    const touched = [...bars, bar(4, 24, 24, 10, 11)];
    expect(nakedPocs(sess, touched, 1)).toEqual([]);
  });
});

describe("value relationships", () => {
  const prior = { val: 10, vah: 20 };
  it("classifies two-day value placement", () => {
    expect(valueRelation({ val: 21, vah: 30 }, prior)).toBe("higher");
    expect(valueRelation({ val: 1, vah: 9 }, prior)).toBe("lower");
    expect(valueRelation({ val: 15, vah: 25 }, prior)).toBe("overlapping-higher");
    expect(valueRelation({ val: 5, vah: 15 }, prior)).toBe("overlapping-lower");
    expect(valueRelation({ val: 12, vah: 18 }, prior)).toBe("inside");
    expect(valueRelation({ val: 8, vah: 22 }, prior)).toBe("outside");
    expect(valueRelation({ val: 10, vah: 20 }, prior)).toBe("unchanged");
  });
  it("price location vs value (row units)", () => {
    // VA rows 10..20 with row size 5 → [50, 105)
    expect(locationVsValue(105, prior, 5)).toBe("above");
    expect(locationVsValue(104, prior, 5)).toBe("inside");
    expect(locationVsValue(50, prior, 5)).toBe("inside");
    expect(locationVsValue(49, prior, 5)).toBe("below");
  });
});

describe("CVD divergence", () => {
  it("higher high with lower CVD = bearish context", () => {
    const bars = [bar(0, 1, 5, 1, 4), bar(1, 4, 10, 3, 9), bar(2, 9, 9, 6, 7), bar(3, 7, 8, 6, 7), bar(4, 7, 11, 6, 10)];
    const cvd = [10, 50, 40, 35, 30];
    const d = cvdDivergences(bars, cvd, 10);
    expect(d).toEqual([{ idx: 4, kind: "bearish", refIdx: 1 }]);
  });
});
