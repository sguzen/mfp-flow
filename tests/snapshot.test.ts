import { describe, expect, it } from "vitest";
import { snapshotCaption, snapshotFilename } from "../src/render/snapshot";

const AT = new Date("2026-10-05T13:24:59.000Z");

describe("snapshotCaption", () => {
  it("names market, view, timeframe and session date", () => {
    expect(snapshotCaption({ market: "XYZ100 (NAS100)", view: "footprint", tfMin: 5, sessionDate: "05 Oct", at: AT })).toEqual({
      left: "XYZ100 (NAS100) · Footprint 5m · session 05 Oct",
      right: "2026-10-05 13:24 UTC · mfp·flow · data: MyFundedPerps",
    });
  });
  it("TPO is always 30m, so the timeframe is not repeated", () => {
    expect(snapshotCaption({ market: "BTC", view: "tpo", tfMin: 5, sessionDate: "05 Oct", at: AT }).left).toBe(
      "BTC · TPO 30m · session 05 Oct",
    );
  });
  it("profiles keeps its timeframe", () => {
    expect(snapshotCaption({ market: "BTC", view: "profiles", tfMin: 30, sessionDate: "05 Oct", at: AT }).left).toBe(
      "BTC · Profiles 30m · session 05 Oct",
    );
  });
  it("always carries the attribution", () => {
    for (const view of ["footprint", "profiles", "tpo"] as const)
      expect(snapshotCaption({ market: "BTC", view, tfMin: 5, sessionDate: "05 Oct", at: AT }).right).toContain(
        "mfp·flow · data: MyFundedPerps",
      );
  });
  it("stamps whole minutes in UTC, never local time", () => {
    // 23:59:59.999 UTC must not round up into the next day
    const edge = new Date("2026-10-05T23:59:59.999Z");
    expect(snapshotCaption({ market: "BTC", view: "tpo", tfMin: 30, sessionDate: "05 Oct", at: edge }).right).toMatch(
      /^2026-10-05 23:59 UTC/,
    );
  });
});

describe("snapshotFilename", () => {
  it("slugs the market id", () => {
    expect(snapshotFilename("hyperliquid|xyz:XYZ100", "tpo", AT)).toBe("mfp-flow_hyperliquid-xyz-xyz100_tpo_202610051324.png");
  });
  it("has no characters that need escaping", () => {
    const n = snapshotFilename("binance|BTCUSDT", "footprint", AT);
    expect(n).toBe("mfp-flow_binance-btcusdt_footprint_202610051324.png");
    expect(n).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});
