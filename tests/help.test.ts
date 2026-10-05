import { describe, expect, it } from "vitest";
import { DISCLAIMER, HELP } from "../src/help";

const VIEWS = ["footprint", "profiles", "tpo"] as const;

describe("explainer copy", () => {
  it("covers every view", () => {
    for (const v of VIEWS) expect(HELP[v]).toBeTruthy();
  });

  it("gives 4-6 bullets per view, as the brief asks", () => {
    for (const v of VIEWS) {
      expect(HELP[v].bullets.length).toBeGreaterThanOrEqual(4);
      expect(HELP[v].bullets.length).toBeLessThanOrEqual(6);
    }
  });

  it("keeps each bullet short enough to read at a glance", () => {
    for (const v of VIEWS) for (const b of HELP[v].bullets) expect(b.length).toBeLessThanOrEqual(190);
  });

  // PLAN.md standing rule: never write "signal", "edge" or "win rate". The ban
  // is on the literal words, so chart-edge wording has to be phrased some other
  // way ("the newest session on screen") rather than weakening this test.
  it("never promises an edge or calls anything a signal", () => {
    const banned = /\b(signal|signals|edge|win rate|winrate|profitable|guarantee[ds]?|alpha)\b/i;
    for (const v of VIEWS) {
      expect(HELP[v].title).not.toMatch(banned);
      for (const b of HELP[v].bullets) expect(b, `${v}: ${b}`).not.toMatch(banned);
    }
  });

  it("the disclaimer is the one place “signals” appears, and only to deny it", () => {
    expect(DISCLAIMER).toBe("Context, not signals.");
  });

  it("says what a TPO letter is, which is the 20-second test", () => {
    const first = HELP.tpo.bullets[0].toLowerCase();
    expect(first).toContain("letter");
    expect(first).toContain("30-minute");
  });

  it("is explicit that estimated data is not real aggressor flow", () => {
    expect(HELP.footprint.bullets.join(" ")).toMatch(/hatched/i);
    expect(HELP.footprint.bullets.join(" ")).toMatch(/not known|not claimed/i);
  });

  it("flags TPO as exact, since that is what separates it from the volume split", () => {
    expect(HELP.tpo.bullets.join(" ")).toMatch(/exact/i);
  });
});
