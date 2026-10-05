import { describe, expect, it } from "vitest";
import { nyOffsetMs, prevSessionStart, sessionEnd, sessionStart } from "../src/analytics/session";

const T = (s: string) => Date.parse(s);
const H = 3_600_000;

describe("UTC day sessions", () => {
  const spec = { mode: "utc" as const };
  it("start at 00:00Z", () => {
    expect(sessionStart(T("2026-10-05T07:00:00Z"), spec)).toBe(T("2026-10-05T00:00:00Z"));
    expect(sessionStart(T("2026-10-05T00:00:00Z"), spec)).toBe(T("2026-10-05T00:00:00Z"));
    expect(sessionStart(T("2026-10-04T23:59:59.999Z"), spec)).toBe(T("2026-10-04T00:00:00Z"));
    expect(sessionEnd(T("2026-10-05T00:00:00Z"), spec)).toBe(T("2026-10-06T00:00:00Z"));
  });
  it("custom UTC hour", () => {
    const s = { mode: "utcHour" as const, utcHour: 22 };
    expect(sessionStart(T("2026-10-05T07:00:00Z"), s)).toBe(T("2026-10-04T22:00:00Z"));
    expect(sessionStart(T("2026-10-05T22:00:00Z"), s)).toBe(T("2026-10-05T22:00:00Z"));
  });
});

describe("NY 18:00 sessions (DST aware)", () => {
  const spec = { mode: "ny18" as const };
  it("offsets", () => {
    expect(nyOffsetMs(T("2026-07-01T12:00:00Z"))).toBe(-4 * H);
    expect(nyOffsetMs(T("2026-12-01T12:00:00Z"))).toBe(-5 * H);
  });
  it("summer (EDT): 18:00 ET = 22:00Z", () => {
    expect(sessionStart(T("2026-10-05T07:00:00Z"), spec)).toBe(T("2026-10-04T22:00:00Z"));
    expect(sessionStart(T("2026-10-04T22:00:00Z"), spec)).toBe(T("2026-10-04T22:00:00Z"));
    expect(sessionStart(T("2026-10-04T21:59:59.999Z"), spec)).toBe(T("2026-10-03T22:00:00Z"));
    // NY evening after 18:00 but before UTC midnight
    expect(sessionStart(T("2026-10-04T23:30:00Z"), spec)).toBe(T("2026-10-04T22:00:00Z"));
  });
  it("winter (EST): 18:00 ET = 23:00Z", () => {
    expect(sessionStart(T("2026-12-01T12:00:00Z"), spec)).toBe(T("2026-11-30T23:00:00Z"));
    expect(sessionStart(T("2026-12-01T22:30:00Z"), spec)).toBe(T("2026-11-30T23:00:00Z"));
    expect(sessionStart(T("2026-12-01T23:00:00Z"), spec)).toBe(T("2026-12-01T23:00:00Z"));
    // after UTC midnight, still the previous NY evening's session
    expect(sessionStart(T("2026-12-02T00:30:00Z"), spec)).toBe(T("2026-12-01T23:00:00Z"));
  });
  it("fall back (Nov 1 2026): 25h session", () => {
    const s = T("2026-10-31T22:00:00Z"); // Sat 18:00 EDT
    expect(sessionStart(T("2026-11-01T12:00:00Z"), spec)).toBe(s);
    expect(sessionEnd(s, spec)).toBe(T("2026-11-01T23:00:00Z")); // Sun 18:00 EST
    expect(sessionEnd(s, spec) - s).toBe(25 * H);
    expect(sessionStart(T("2026-11-01T22:30:00Z"), spec)).toBe(s);
    expect(prevSessionStart(T("2026-11-01T23:00:00Z"), spec)).toBe(s);
  });
  it("spring forward (Mar 8 2026): 23h session", () => {
    const s = T("2026-03-07T23:00:00Z"); // Sat 18:00 EST
    expect(sessionStart(T("2026-03-08T12:00:00Z"), spec)).toBe(s);
    expect(sessionEnd(s, spec)).toBe(T("2026-03-08T22:00:00Z")); // Sun 18:00 EDT
    expect(sessionEnd(s, spec) - s).toBe(23 * H);
  });
});
