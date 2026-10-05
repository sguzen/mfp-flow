import { describe, expect, it } from "vitest";
import { closeLocationDelta, distributeCandle } from "../src/analytics/estimate";
import { Coverage, FootprintBook, MINUTE } from "../src/analytics/footprint";
import { diagonalImbalances, stackedImbalances } from "../src/analytics/imbalance";
import { normTrade } from "../src/analytics/normalize";
import { parseUnits } from "../src/analytics/price";
import { MinuteSource, buildBars, buildSessions, cvdSeries, minuteKeys } from "../src/analytics/series";
import type { Candle, Cell, Trade } from "../src/analytics/types";

const U = parseUnits;
const tr = (id: string, t: number, px: string, sz: number, side: 1 | -1): Trade => ({ id, t, px: U(px), sz, side });

describe("FootprintBook", () => {
  it("aggregates aggressor volume per fine row and dedupes by tradeId", () => {
    const fb = new FootprintBook(U("0.01"));
    expect(fb.add(tr("a", 1_000, "100.00", 1, 1))).toBe(true);
    expect(fb.add(tr("b", 2_000, "100.004", 2, -1))).toBe(true); // same 0.01 row as 100.00
    expect(fb.add(tr("c", 3_000, "100.01", 0.5, 1))).toBe(true);
    expect(fb.add(tr("a", 1_000, "100.00", 1, 1))).toBe(false); // replayed duplicate
    expect(fb.dupes).toBe(1);
    const m = fb.minutes.get(0)!;
    expect(m.cells.get(10000)).toEqual([1, 2]);
    expect(m.cells.get(10001)).toEqual([0.5, 0]);
    expect(m.buy).toBe(1.5);
    expect(m.sell).toBe(2);
    expect([m.o, m.h, m.l, m.c]).toEqual([U("100.00"), U("100.01"), U("100.00"), U("100.01")]);
  });
  it("open/close follow exchange time even when trades arrive out of order", () => {
    const fb = new FootprintBook(U("0.01"));
    fb.add(tr("x", 30_000, "101", 1, 1));
    fb.add(tr("y", 10_000, "99", 1, -1));
    fb.add(tr("z", 20_000, "100", 1, 1));
    const m = fb.minutes.get(0)!;
    expect(m.o).toBe(U("99"));
    expect(m.c).toBe(U("101"));
  });
  it("normalizes wire trades", () => {
    const t = normTrade({ provider: "binance", symbol: "BTCUSDT", tradeId: "3475281483", side: "sell", price: "86163.90", size: "0.587", time: 1791183212352 })!;
    expect(t).toEqual({ id: "3475281483", t: 1791183212352, px: 8_616_390_000_000, sz: 0.587, side: -1 });
  });
});

describe("Coverage", () => {
  it("first partially covered minute is not real; later minutes are", () => {
    const c = new Coverage();
    c.begin();
    c.note(10_000, 15_000);
    expect(c.isMinuteReal(0)).toBe(false);
    expect(c.isMinuteReal(MINUTE)).toBe(true);
    c.end(200_000);
    expect(c.isMinuteReal(MINUTE)).toBe(true);
    expect(c.isMinuteReal(10 * MINUTE)).toBe(false);
  });
  it("a replay that overlaps the previous segment keeps coverage continuous", () => {
    const c = new Coverage();
    c.begin();
    c.note(10_000, 100_000);
    c.end(100_000);
    c.begin();
    c.note(90_000, 400_000); // retained replay reaches back before the disconnect
    expect(c.segments.length).toBe(1);
    expect(c.isMinuteReal(2 * MINUTE)).toBe(true);
  });
});

describe("candle estimation", () => {
  const cd: Candle = { t: 0, o: U("100.00"), h: U("100.09"), l: U("100.00"), c: U("100.09"), v: 10 };
  it("distributes volume over [low, high + tick) by overlap", () => {
    // range 100.00..100.10 (0.10 wide); rows of 0.05: [100.00,100.05) and [100.05,100.10) -> 5 / 5
    const d = distributeCandle(cd, U("0.05"), U("0.01"));
    expect(d).toEqual([
      [2000, 5],
      [2001, 5],
    ]);
    // rows of 0.03 starting at 99.99: [99.99,100.02) gets 0.02/0.10, [100.02,100.05) .03, [100.05,100.08) .03, [100.08,100.11) .02
    const e = distributeCandle(cd, U("0.03"), U("0.01"));
    expect(e.map(([, v]) => +v.toFixed(9))).toEqual([2, 3, 3, 2]);
    expect(e.reduce((s, [, v]) => s + v, 0)).toBeCloseTo(10, 12);
  });
  it("single-row candles put all volume in one row", () => {
    expect(distributeCandle({ ...cd, h: U("100.02") }, U("0.05"), U("0.01"))).toEqual([[2000, 10]]);
  });
  it("close-location delta", () => {
    expect(closeLocationDelta(cd)).toBe(10); // close on high
    expect(closeLocationDelta({ ...cd, c: cd.l })).toBe(-10);
    expect(closeLocationDelta({ ...cd, h: U("100.10"), c: U("100.05") })).toBeCloseTo(0, 12);
    expect(closeLocationDelta({ ...cd, h: cd.l, c: cd.l })).toBe(0);
  });
});

describe("bars from mixed sources (no double counting)", () => {
  const fine = U("0.01");
  const fb = new FootprintBook(fine);
  // minute 1: real trades
  fb.add(tr("1", MINUTE + 1_000, "100.00", 2, 1));
  fb.add(tr("2", MINUTE + 2_000, "100.06", 1, -1));
  // minute 2: partially recorded (the page opened mid-minute)
  fb.add(tr("3", 2 * MINUTE + 50_000, "100.06", 1, 1));
  const candles = new Map<number, Candle>([
    [0, { t: 0, o: U("100.00"), h: U("100.09"), l: U("100.00"), c: U("100.09"), v: 10 }],
    [MINUTE, { t: MINUTE, o: U("100.00"), h: U("100.06"), l: U("100.00"), c: U("100.06"), v: 999 }], // must be ignored
    [2 * MINUTE, { t: 2 * MINUTE, o: U("100.05"), h: U("100.05"), l: U("100.05"), c: U("100.05"), v: 4 }],
  ]);
  const src: MinuteSource = {
    minutes: fb.minutes,
    candles,
    fine,
    tick: U("0.01"),
    isReal: (m) => m === MINUTE,
  };
  const keys = minuteKeys(src);
  it("1m bars: est / real / mixed", () => {
    const bars = buildBars(src, keys, MINUTE, U("0.05"), { mode: "utc" });
    expect(bars.length).toBe(3);
    const [b0, b1, b2] = bars;
    expect(b0.estVol).toBe(10);
    expect(b0.estDelta).toBe(10);
    expect(b0.realDelta).toBe(0);
    expect(b1.vol).toBe(3); // the candle's 999 is ignored: the minute is real
    expect(b1.realDelta).toBe(1);
    expect(b1.cells.get(2000)).toEqual({ b: 2, s: 0, e: 0 });
    expect(b1.cells.get(2001)).toEqual({ b: 0, s: 1, e: 0 });
    expect(b2.buy).toBe(1);
    expect(b2.estVol).toBe(3); // 4 - 1 recorded
    expect(b2.vol).toBe(4);
    expect(b2.realMinutes).toBe(0);
  });
  it("5m bar aggregates all minutes; session profile sums cells", () => {
    const bars = buildBars(src, keys, 5 * MINUTE, U("0.05"), { mode: "utc" });
    expect(bars.length).toBe(1);
    expect(bars[0].vol).toBe(17);
    expect(bars[0].o).toBe(U("100.00"));
    expect(bars[0].c).toBe(U("100.06"));
    const [s] = buildSessions(bars);
    expect(s.profile.total).toBe(17);
    // row 2000: est 5 + real 2 = 7; row 2001: est 5 + real 1 + mixed (1 real + 3 est at 100.05) = 10
    expect(s.va!.poc).toBe(2001);
    const cvd = cvdSeries(bars, false);
    expect(cvd[0]).toBe(2); // real only: +2 -1 +1
  });
  it("bars never straddle a session boundary", () => {
    const t0 = Date.parse("2026-10-04T21:58:00Z");
    const cs = new Map<number, Candle>();
    for (let i = 0; i < 4; i++) cs.set(t0 + i * MINUTE, { t: t0 + i * MINUTE, o: U("1"), h: U("1"), l: U("1"), c: U("1"), v: 1 });
    const s2: MinuteSource = { minutes: new Map(), candles: cs, fine, tick: fine, isReal: () => false };
    const bars = buildBars(s2, minuteKeys(s2), 30 * MINUTE, U("0.05"), { mode: "ny18" });
    expect(bars.map((b) => new Date(b.t).toISOString())).toEqual(["2026-10-04T21:30:00.000Z", "2026-10-04T22:00:00.000Z"]);
    expect(bars[0].session).not.toBe(bars[1].session);
  });
});

describe("diagonal imbalances", () => {
  it("compares ask(r) with bid(r-1) and bid(r) with ask(r+1)", () => {
    const cells = new Map<number, Cell>([
      [10, { b: 1, s: 5, e: 0 }],
      [11, { b: 15, s: 2, e: 0 }], // 15 >= 3 × bid(10)=5 -> buy imbalance
      [12, { b: 2, s: 7, e: 0 }], // bid(12)=7 >= 3 × ask(13)=2 -> sell imbalance; ask(12)=2 vs bid(11)=2 no
      [13, { b: 2, s: 0, e: 0 }],
    ]);
    const imb = diagonalImbalances(cells, 3);
    expect(imb.map((i) => `${i.side}@${i.row}`).sort()).toEqual(["buy@11", "sell@12"]);
    expect(stackedImbalances(imb, 2)).toEqual([]);
  });
});
