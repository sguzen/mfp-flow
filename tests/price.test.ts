import { describe, expect, it } from "vitest";
import { bucketOf, chooseBuckets, decimalsFor, fineUnitsFor, floorDiv, formatUnits, inferTick, niceCeil, parseUnits } from "../src/analytics/price";

describe("parseUnits (decimal strings -> integer 1e-8 units)", () => {
  it("parses exactly", () => {
    expect(parseUnits("86163.90")).toBe(8_616_390_000_000);
    expect(parseUnits("30775.0")).toBe(3_077_500_000_000);
    expect(parseUnits("4154")).toBe(415_400_000_000);
    expect(parseUnits("0.00000001")).toBe(1);
    expect(parseUnits("-1.5")).toBe(-150_000_000);
  });
  it("is exact where floats are not (0.1 + 0.2)", () => {
    expect(parseUnits("0.1") + parseUnits("0.2")).toBe(parseUnits("0.3"));
  });
  it("rounds half-up beyond 8 dp", () => {
    expect(parseUnits("1.123456785")).toBe(112_345_679);
    expect(parseUnits("1.123456784")).toBe(112_345_678);
  });
  it("rejects garbage", () => {
    expect(() => parseUnits("1e5")).toThrow();
    expect(() => parseUnits("abc")).toThrow();
  });
});

describe("bucketing", () => {
  it("floors into [k*b, (k+1)*b)", () => {
    const ten = parseUnits("10");
    expect(bucketOf(parseUnits("86163.90"), ten)).toBe(8616);
    expect(bucketOf(parseUnits("86160"), ten)).toBe(8616);
    expect(bucketOf(parseUnits("86159.99"), ten)).toBe(8615);
    const half = parseUnits("0.5");
    expect(bucketOf(parseUnits("4154.0"), half)).toBe(8308);
    expect(bucketOf(parseUnits("4154.4999"), half)).toBe(8308);
    expect(bucketOf(parseUnits("4154.5"), half)).toBe(8309);
  });
  it("floorDiv handles negatives", () => {
    expect(floorDiv(-5, 10)).toBe(-1);
    expect(floorDiv(-10, 10)).toBe(-1);
    expect(floorDiv(-11, 10)).toBe(-2);
    expect(floorDiv(19, 10)).toBe(1);
  });
  it("re-bucketing fine rows equals bucketing raw prices", () => {
    const fine = parseUnits("0.01");
    const row = parseUnits("5");
    for (const p of ["30775.00", "30779.99", "30780.00", "30774.99", "30770.01"]) {
      const u = parseUnits(p);
      expect(floorDiv(bucketOf(u, fine), row / fine)).toBe(bucketOf(u, row));
    }
  });
});

describe("row size defaults", () => {
  it("niceCeil", () => {
    expect(niceCeil(8.6)).toBe(10);
    expect(niceCeil(3.08)).toBe(5);
    expect(niceCeil(0.415)).toBe(0.5);
    expect(niceCeil(0.68)).toBe(1);
    expect(niceCeil(2.1)).toBe(2.5);
    expect(niceCeil(2)).toBe(2);
  });
  it("fine storage granularity", () => {
    expect(fineUnitsFor(parseUnits("86000"))).toBe(parseUnits("0.01"));
    expect(fineUnitsFor(parseUnits("30775"))).toBe(parseUnits("0.01"));
    expect(fineUnitsFor(parseUnits("4154"))).toBe(parseUnits("0.001"));
    expect(fineUnitsFor(parseUnits("0.0123"))).toBe(1);
  });
  it("per-market defaults ≈ 1bp, nice, multiple of tick", () => {
    expect(chooseBuckets(parseUnits("86163.9"), parseUnits("0.1")).defaultUnits).toBe(parseUnits("10"));
    expect(chooseBuckets(parseUnits("30775"), parseUnits("1")).defaultUnits).toBe(parseUnits("5"));
    expect(chooseBuckets(parseUnits("4154.0"), parseUnits("0.1")).defaultUnits).toBe(parseUnits("0.5"));
    const c = chooseBuckets(parseUnits("4154.0"), parseUnits("0.1"));
    for (const o of c.options) {
      expect(o % parseUnits("0.1")).toBe(0);
      expect(o % c.fineUnits).toBe(0);
    }
  });
  it("tick inference and decimals", () => {
    expect(inferTick([parseUnits("30775.0"), parseUnits("30776.0"), parseUnits("30790")])).toBe(parseUnits("1"));
    expect(decimalsFor(parseUnits("0.5"))).toBe(1);
    expect(decimalsFor(parseUnits("10"))).toBe(0);
    expect(decimalsFor(parseUnits("2.5"))).toBe(1);
  });
  it("formats", () => {
    expect(formatUnits(parseUnits("86163.9"), 2)).toBe("86,163.90");
    expect(formatUnits(parseUnits("4154.5"), 1)).toBe("4,154.5");
    expect(formatUnits(parseUnits("0.00012"), 5)).toBe("0.00012");
  });
});
