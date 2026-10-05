import { describe, expect, it } from "vitest";
import type { MinuteFP } from "../src/analytics/types";
import { mergeRestored, normaliseBase } from "../src/data/recorder";

const m = (t: number, n: number): MinuteFP => ({
  t, o: 1, h: 1, l: 1, c: 1, buy: n, sell: 0, n, firstT: t, lastT: t, cells: new Map([[1, [n, 0]]]),
});

describe("normaliseBase", () => {
  it("trims whitespace and trailing slashes", () => {
    expect(normaliseBase("  http://localhost:8787/// ")).toBe("http://localhost:8787");
    expect(normaliseBase("")).toBe("");
  });
});

describe("mergeRestored", () => {
  it("returns whichever side exists when the other does not", () => {
    const a = { minutes: [m(1, 1)], segments: [] };
    expect(mergeRestored(a, null)).toBe(a);
    expect(mergeRestored(null, a)).toBe(a);
    expect(mergeRestored(null, null)).toBeNull();
  });

  it("unions distinct minutes and keeps them in time order", () => {
    const r = mergeRestored(
      { minutes: [m(300, 1), m(100, 1)], segments: [] },
      { minutes: [m(200, 1)], segments: [] },
    )!;
    expect(r.minutes.map((x) => x.t)).toEqual([100, 200, 300]);
  });

  // A browser open for ten seconds saw part of a minute; the recorder saw all
  // of it. The fuller record has to win, or merging would lose trades.
  it("prefers the record with more trades on a clash", () => {
    const r = mergeRestored(
      { minutes: [m(100, 3)], segments: [] },
      { minutes: [m(100, 40)], segments: [] },
    )!;
    expect(r.minutes).toHaveLength(1);
    expect(r.minutes[0].n).toBe(40);
  });
  it("keeps the incumbent when the newcomer is not better", () => {
    const r = mergeRestored(
      { minutes: [m(100, 40)], segments: [] },
      { minutes: [m(100, 3)], segments: [] },
    )!;
    expect(r.minutes[0].n).toBe(40);
  });

  it("carries both sides' coverage segments through", () => {
    const r = mergeRestored(
      { minutes: [], segments: [{ from: 1, to: 2, open: false }] },
      { minutes: [], segments: [{ from: 5, to: 6, open: false }] },
    )!;
    expect(r.segments).toEqual([
      { from: 1, to: 2, open: false },
      { from: 5, to: 6, open: false },
    ]);
  });
});
