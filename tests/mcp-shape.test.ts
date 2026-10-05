import { describe, expect, it } from "vitest";
import type { FailedAuction, NakedPoc } from "../src/analytics/auction";
import { profileFromVolumes } from "../src/analytics/profile";
import type { SessionStats } from "../src/analytics/series";
import type { TpoProfile } from "../src/analytics/tpo";
import { dataQuality, levelsSummary, priceStr, pxAt, relationPhrase, shapeFailed, shapeNaked, shapeOi, shapeSessions, shapeTpo } from "../src/mcp/shape";

const U = 100_000_000; // one price unit (prices are integers at 1e-8)

describe("priceStr", () => {
  it("formats at the asked decimals with no thousands separator", () => {
    // 86,220 must come out machine-readable
    expect(priceStr(86_220 * U, 1)).toBe("86220.0");
    expect(priceStr(86_220 * U, 0)).toBe("86220");
  });
  it("keeps sub-unit ticks exact", () => {
    expect(priceStr(0.00000001 * U, 8)).toBe("0.00000001");
    expect(priceStr(1.5 * U, 2)).toBe("1.50");
  });
  it("pads to the requested decimals", () => {
    expect(priceStr(2 * U, 3)).toBe("2.000");
  });
  it("handles negatives", () => {
    expect(priceStr(-12.25 * U, 2)).toBe("-12.25");
  });
  it("round-trips through Number", () => {
    for (const v of [86_220, 0.5, 1234.75, 30_825]) expect(Number(priceStr(v * U, 4))).toBeCloseTo(v, 6);
  });
});

/** A session whose value area sits on rows 10..12 with a POC at row 11. */
function session(start: number, poc: number, val: number, vah: number, over: Partial<SessionStats> = {}): SessionStats {
  return {
    start,
    i0: 0,
    i1: 0,
    profile: profileFromVolumes({ [val]: 5, [poc]: 20, [vah]: 5 }),
    va: { poc, vah, val, volume: 30, pct: 0.7 },
    high: rowTop(vah),
    low: rowBottom(val),
    dpoc: [],
    realShare: 1,
    realDelta: 0,
    estDelta: 0,
    volume: 30,
    ...over,
  };
}
const ROW = 5 * U; // a 5-unit row size
const rowBottom = (r: number) => r * ROW;
const rowTop = (r: number) => (r + 1) * ROW;
const px = pxAt(1);

describe("shapeSessions", () => {
  const DAY = 86_400_000;
  const a = session(Date.UTC(2026, 9, 4), 11, 10, 12);
  const b = session(Date.UTC(2026, 9, 5), 13, 12, 14, { realShare: 0.254, volume: 61_234.6 });
  const rows = shapeSessions([a, b], ROW, px);

  it("puts POC and VAL at the row low and VAH at the row top, like the chart", () => {
    // row 11 low = 55, row 10 low = 50, row 12 top = 65
    expect(rows[0].poc).toBe("55.0");
    expect(rows[0].val).toBe("50.0");
    expect(rows[0].vah).toBe("65.0");
  });
  it("dates each session from its UTC start", () => {
    expect(rows[0].date).toBe("2026-10-04");
    expect(rows[1].date).toBe("2026-10-05");
  });
  it("compares value with the prior session, and leaves the first alone", () => {
    expect(rows[0].value_vs_prior).toBeNull();
    // 12..14 against 10..12 overlaps upward
    expect(rows[1].value_vs_prior).toBe("overlapping-higher");
  });
  it("reports real share as a percentage to one decimal", () => {
    expect(rows[1].real_share_pct).toBe(25.4);
  });
  it("rounds volume to a whole number", () => {
    expect(rows[1].volume).toBe(61_235);
  });
  it("is one row per session, in order", () => {
    expect(rows).toHaveLength(2);
    expect(new Date(rows[0].start).getTime()).toBeLessThan(new Date(rows[1].start).getTime());
  });
  void DAY;
});

function tpo(over: Partial<TpoProfile> = {}): TpoProfile {
  return {
    start: Date.UTC(2026, 9, 5),
    lo: 10,
    hi: 14,
    rows: [],
    periods: 21,
    poc: 12,
    va: { poc: 12, vah: 13, val: 11, volume: 0, pct: 0.7 },
    ib: { hiRow: 13, loRow: 11 },
    rangeExtUp: true,
    rangeExtDown: false,
    singlePrints: [{ from: 10, to: 10 }],
    topTail: 2,
    bottomTail: 0,
    poorHigh: true,
    poorLow: false,
    counts: [],
    ...over,
  };
}

describe("shapeTpo", () => {
  const s = session(Date.UTC(2026, 9, 5), 12, 11, 13);
  it("reports IB as high/low/range off the row bounds", () => {
    const [r] = shapeTpo([s], [tpo()], ROW, px);
    // hiRow 13 top = 70, loRow 11 low = 55, range 15
    expect(r.initial_balance).toEqual({ high: "70.0", low: "55.0", range: "15.0" });
  });
  it("names the range extension side", () => {
    expect(shapeTpo([s], [tpo()], ROW, px)[0].range_extension).toBe("up");
    expect(shapeTpo([s], [tpo({ rangeExtDown: true })], ROW, px)[0].range_extension).toBe("both");
    expect(shapeTpo([s], [tpo({ rangeExtUp: false })], ROW, px)[0].range_extension).toBe("none");
  });
  it("spans single prints from the row low to the row top", () => {
    expect(shapeTpo([s], [tpo()], ROW, px)[0].single_prints).toEqual([{ from: "50.0", to: "55.0" }]);
  });
  it("carries tails and poor extremes through", () => {
    const [r] = shapeTpo([s], [tpo()], ROW, px);
    expect(r.tails).toEqual({ top_rows: 2, bottom_rows: 0 });
    expect(r.poor_high).toBe(true);
    expect(r.poor_low).toBe(false);
  });
  it("skips sessions with no TPO rather than emitting a hole", () => {
    expect(shapeTpo([s, s], [tpo(), null], ROW, px)).toHaveLength(1);
  });
});

describe("shapeNaked", () => {
  const naked: NakedPoc[] = [{ session: Date.UTC(2026, 9, 1), row: 10 }];
  it("measures distance from the last price as a signed percentage", () => {
    // row 10 low = 50, last = 40 -> +25%
    expect(shapeNaked(naked, ROW, px, 40 * U)[0]).toEqual({ price: "50.0", session: "2026-10-01", distance_pct: 25 });
  });
  it("reports a POC below the last price as negative", () => {
    expect(shapeNaked(naked, ROW, px, 100 * U)[0].distance_pct).toBe(-50);
  });
  it("omits the distance when there is no last price", () => {
    expect(shapeNaked(naked, ROW, px, null)[0].distance_pct).toBeNull();
  });
});

describe("shapeFailed", () => {
  const base: FailedAuction = {
    ref: { label: "prior VAH", price: 60 * U, dir: 1 },
    breakIdx: 3,
    backIdx: 7,
    extreme: 72 * U,
    excursionDelta: -12.345,
    deltaQuality: "real",
    supported: false,
  };
  it("reports recorded delta and whether it backed the break", () => {
    expect(shapeFailed([base], px)[0]).toEqual({
      reference: "prior VAH",
      direction: "above",
      extreme: "72.0",
      excursion_delta: -12.35,
      delta_quality: "real",
      delta_supported_break: false,
    });
  });
  it("rounds signed delta symmetrically, so the sign does not shift the figure", () => {
    const neg = shapeFailed([{ ...base, excursionDelta: -12.345 }], px)[0].excursion_delta;
    const pos = shapeFailed([{ ...base, excursionDelta: 12.345 }], px)[0].excursion_delta;
    expect(neg).toBe(-12.35);
    expect(pos).toBe(12.35);
    expect(neg).toBe(-pos!);
  });

  // The project rule: estimated delta is never presented as if it were measured.
  it("withholds delta that was only estimated", () => {
    for (const q of ["estimated", "mixed"] as const) {
      const r = shapeFailed([{ ...base, deltaQuality: q }], px)[0];
      expect(r.excursion_delta).toBeNull();
      expect(r.delta_supported_break).toBeNull();
      expect(r.delta_quality).toBe(q);
    }
  });
});

describe("dataQuality", () => {
  it("states the real share and that TPO is exact", () => {
    const q = dataQuality(0.1234, Date.UTC(2026, 9, 5, 12));
    expect(q.real_volume_share_pct).toBe(12.3);
    expect(q.tpo).toMatch(/exact/);
    expect(q.delta).toContain("2026-10-05T12:00:00.000Z");
  });
  it("says plainly when nothing has been recorded", () => {
    expect(dataQuality(0, null).delta).toMatch(/No live trades recorded/);
  });
});

describe("relationPhrase", () => {
  it("reads as English for every value relation", () => {
    expect(relationPhrase("higher")).toBe("value higher than prior");
    expect(relationPhrase("overlapping-higher")).toBe("value overlapping higher than prior");
    // "outside than prior" is not English, which is why these are mapped
    expect(relationPhrase("outside")).toBe("value outside prior value");
    expect(relationPhrase("inside")).toBe("value inside prior value");
    expect(relationPhrase("unchanged")).toBe("value unchanged from prior");
  });
  it("never produces a dangling \"than\"", () => {
    for (const r of ["higher", "lower", "overlapping-higher", "overlapping-lower", "unchanged", "inside", "outside"])
      expect(relationPhrase(r)).not.toMatch(/\b(outside|inside|unchanged) than\b/);
  });
});

describe("levelsSummary", () => {
  it("always ends on the standing disclaimer", () => {
    const s = levelsSummary({ market: "BTC", last: "86200.0", location: "inside", relation: "outside", naked: 0, failed: 2 });
    expect(s).toMatch(/Context, not signals\.$/);
    expect(s).toContain("value outside prior value");
    expect(s).toContain("0 naked POCs");
    expect(s).toContain("2 failed auctions today");
  });
  it("singularises counts of one", () => {
    const s = levelsSummary({ market: "BTC", last: null, location: null, relation: null, naked: 1, failed: 1 });
    expect(s).toContain("1 naked POC ");
    expect(s).toContain("1 failed auction ");
  });
});

describe("open interest in the MCP response", () => {
  it("reports the change as a percentage and its reading", () => {
    expect(shapeOi({ deltaOiPct: 0.0214, label: "new longs" })).toEqual({ change_pct: 2.14, reading: "new longs" });
  });
  it("keeps the sign on a fall", () => {
    expect(shapeOi({ deltaOiPct: -0.012, label: "long liquidation" })!.change_pct).toBe(-1.2);
  });
  // an agent must not be told "0%" when the answer is "we did not look"
  it("is null when OI was never observed", () => {
    expect(shapeOi(null)).toBeNull();
  });
  it("rides along with each session, aligned by index", () => {
    const a = session(Date.UTC(2026, 9, 4), 11, 10, 12);
    const b = session(Date.UTC(2026, 9, 5), 13, 12, 14);
    const rows = shapeSessions([a, b], ROW, px, [null, { deltaOiPct: 0.03, label: "new longs" }]);
    expect(rows[0].open_interest).toBeNull();
    expect(rows[1].open_interest).toEqual({ change_pct: 3, reading: "new longs" });
  });
  it("sessions with no OI series at all report null, not a crash", () => {
    const rows = shapeSessions([session(Date.UTC(2026, 9, 4), 11, 10, 12)], ROW, px);
    expect(rows[0].open_interest).toBeNull();
  });
});

describe("data_quality names the OI source", () => {
  it("says when history was backfilled", () => {
    expect(dataQuality(1, null, { live: true, history: "Binance openInterestHist at 15m" }).open_interest).toContain("backfilled from Binance");
  });
  it("says plainly when the venue publishes none", () => {
    expect(dataQuality(1, null, { live: true, history: null }).open_interest).toContain("no OI history");
  });
  it("says when OI was not looked at", () => {
    expect(dataQuality(1, null).open_interest).toMatch(/not observed/);
  });
});
