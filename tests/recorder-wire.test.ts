import { describe, expect, it } from "vitest";
import type { MinuteFP } from "../src/analytics/types";
import { decodeMinute, decodeMinutes, decodeSegment, encodeMinute } from "../src/data/recorder-wire";

const fp = (over: Partial<MinuteFP> = {}): MinuteFP => ({
  t: 1_760_000_000_000,
  o: 100,
  h: 110,
  l: 95,
  c: 105,
  buy: 12,
  sell: 8,
  n: 20,
  firstT: 1_760_000_000_111,
  lastT: 1_760_000_059_999,
  cells: new Map([
    [10, [5, 3]],
    [11, [7, 5]],
  ]),
  ...over,
});

describe("round trip", () => {
  it("survives encode then decode", () => {
    const original = fp();
    const back = decodeMinute(encodeMinute(original))!;
    expect(back).toEqual(original);
  });
  it("flattens cells to row/buy/sell triples", () => {
    expect(encodeMinute(fp()).cells).toEqual([10, 5, 3, 11, 7, 5]);
  });
  it("keeps an empty minute empty", () => {
    const empty = fp({ cells: new Map() });
    expect(decodeMinute(encodeMinute(empty))!.cells.size).toBe(0);
  });
  it("survives JSON, which is how it actually travels", () => {
    const back = decodeMinute(JSON.parse(JSON.stringify(encodeMinute(fp()))))!;
    expect(back).toEqual(fp());
  });
});

// The recorder URL is typed in by the user, so its responses are untrusted.
describe("decoding rejects bad input instead of corrupting the chart", () => {
  it("refuses a record with no timestamp", () => {
    expect(decodeMinute({ o: 1, cells: [] })).toBeNull();
    expect(decodeMinute({ t: "soon", cells: [] })).toBeNull();
  });
  it("refuses non-objects", () => {
    for (const bad of [null, undefined, 42, "minute", []]) expect(decodeMinute(bad)).toBeNull();
  });
  it("drops a trailing partial triple rather than reading it as zeroes", () => {
    const d = decodeMinute({ t: 1, cells: [10, 5, 3, 11, 7] })!;
    expect(d.cells.size).toBe(1);
    expect(d.cells.get(10)).toEqual([5, 3]);
  });
  it("skips cells with non-numeric parts", () => {
    const d = decodeMinute({ t: 1, cells: [10, 5, 3, "x", 7, 5] })!;
    expect([...d.cells.keys()]).toEqual([10]);
  });
  it("defaults missing prices to zero but keeps the minute", () => {
    const d = decodeMinute({ t: 7, cells: [] })!;
    expect(d.t).toBe(7);
    expect(d.o).toBe(0);
    expect(d.firstT).toBe(7);
  });
});

describe("decodeSegment", () => {
  it("reads a coverage segment", () => {
    expect(decodeSegment({ from: 1, to: 2, open: true })).toEqual({ from: 1, to: 2, open: true });
  });
  it("treats a missing open flag as closed", () => {
    expect(decodeSegment({ from: 1, to: 2 })!.open).toBe(false);
  });
  it("refuses a backwards or incomplete segment", () => {
    expect(decodeSegment({ from: 5, to: 1 })).toBeNull();
    expect(decodeSegment({ from: 5 })).toBeNull();
    expect(decodeSegment(null)).toBeNull();
  });
});

describe("decodeMinutes", () => {
  const body = {
    market: "binance|BTCUSDT",
    fine: 1000,
    minutes: [encodeMinute(fp({ t: 200 })), encodeMinute(fp({ t: 100 }))],
    segments: [{ from: 1, to: 2, open: false }],
  };

  it("decodes a whole response and sorts minutes by time", () => {
    const d = decodeMinutes(body)!;
    expect(d.minutes.map((m) => m.t)).toEqual([100, 200]);
    expect(d.segments).toHaveLength(1);
    expect(d.skipped).toBe(0);
    expect(d.fine).toBe(1000);
  });

  // fine is the row size the cells are indexed at: merging at the wrong one
  // would silently put volume at the wrong prices
  it("refuses a response with no usable row size", () => {
    for (const fine of [undefined, 0, -1, "1000", null])
      expect(decodeMinutes({ ...body, fine }), String(fine)).toBeNull();
  });
  it("refuses a non-object body", () => {
    for (const bad of [null, "nope", 7]) expect(decodeMinutes(bad)).toBeNull();
  });
  it("keeps the good records and counts the bad ones", () => {
    const d = decodeMinutes({ ...body, minutes: [encodeMinute(fp()), { nope: 1 }, null], segments: [{ from: 9, to: 1 }] })!;
    expect(d.minutes).toHaveLength(1);
    expect(d.segments).toHaveLength(0);
    expect(d.skipped).toBe(3);
  });
  it("tolerates missing arrays", () => {
    const d = decodeMinutes({ fine: 10 })!;
    expect(d.minutes).toEqual([]);
    expect(d.segments).toEqual([]);
  });
});
