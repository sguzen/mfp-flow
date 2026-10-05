import { describe, expect, it } from "vitest";
import { buildTpo, TPO_PERIOD_MS, tpoLetter } from "../src/analytics/tpo";

const P = (k: number, l: number, h: number) => ({ t: k * TPO_PERIOD_MS, l, h });

describe("TPO profile", () => {
  // A 10-14, B 12-16, C 13-15, D 8-13 (row = 1)
  //   row: 8 9 10 11 12 13 14 15 16
  // count: 1 1  2  2  3  4  3  2  1   total 19
  const tpo = buildTpo(0, [P(0, 10, 14), P(1, 12, 16), P(2, 13, 15), P(3, 8, 13)], 1)!;

  it("stacks periods per row in order", () => {
    expect(tpo.lo).toBe(8);
    expect(tpo.hi).toBe(16);
    expect(tpo.counts).toEqual([1, 1, 2, 2, 3, 4, 3, 2, 1]);
    expect(tpo.rows[13 - 8]).toEqual([0, 1, 2, 3]);
    expect(tpo.rows[16 - 8]).toEqual([1]);
    expect(tpo.periods).toBe(4);
  });

  it("POC and 70% value area on TPO counts", () => {
    // POC 13 (4). Target 13.3. Up pair 14+15 = 5, down pair 12+11 = 5, equal -> both -> 14.
    expect(tpo.poc).toBe(13);
    expect(tpo.va).toMatchObject({ poc: 13, val: 11, vah: 15, volume: 14 });
  });

  it("initial balance and range extension", () => {
    expect(tpo.ib).toEqual({ hiRow: 16, loRow: 10 });
    expect(tpo.rangeExtDown).toBe(true); // D went to 8
    expect(tpo.rangeExtUp).toBe(false);
  });

  it("single prints, tails and poor extremes", () => {
    expect(tpo.singlePrints).toEqual([
      { from: 8, to: 9 },
      { from: 16, to: 16 },
    ]);
    expect(tpo.bottomTail).toBe(2);
    expect(tpo.topTail).toBe(1);
    expect(tpo.poorHigh).toBe(false);
    expect(tpo.poorLow).toBe(false);
  });

  it("flags poor high and low when extremes have 2+ TPOs", () => {
    const t = buildTpo(0, [P(0, 10, 12), P(1, 10, 12)], 1)!;
    expect(t.poorHigh).toBe(true);
    expect(t.poorLow).toBe(true);
    expect(t.singlePrints).toEqual([]);
  });

  it("does not judge excess on a single period", () => {
    const t = buildTpo(0, [P(0, 10, 12)], 1)!;
    expect(t.poorHigh).toBe(false);
  });

  it("buckets by row size and keeps period gaps", () => {
    const t = buildTpo(0, [P(0, 12, 19), P(2, 20, 24)], 5)!;
    expect([t.lo, t.hi]).toEqual([2, 4]);
    expect(t.rows).toEqual([[0], [0], [2]]);
    expect(t.periods).toBe(3);
  });

  it("letters A-X then a-x", () => {
    expect(tpoLetter(0)).toBe("A");
    expect(tpoLetter(23)).toBe("X");
    expect(tpoLetter(24)).toBe("a");
    expect(tpoLetter(47)).toBe("x");
  });
});
