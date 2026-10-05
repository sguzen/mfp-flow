import { describe, expect, it } from "vitest";
import { overlaps, placeLabel, type Rect } from "../src/render/stack";

/** A pill as the chart draws it: 14px tall, centred on `y`, spanning x0..x1. */
const pill = (y: number, x0 = 100, x1 = 200): Rect => ({ x0, x1, y0: y - 7, y1: y + 7 });

describe("overlaps", () => {
  it("same box overlaps itself", () => {
    expect(overlaps(pill(50), pill(50))).toBe(true);
  });
  it("edge-to-edge contact is clear", () => {
    // 43..57 and 57..71 share only the line y=57
    expect(overlaps(pill(50), pill(64))).toBe(false);
  });
  it("one pixel of shared height overlaps", () => {
    // 43..57 and 56..70
    expect(overlaps(pill(50), pill(63))).toBe(true);
  });
  it("disjoint x never overlaps, however close in y", () => {
    expect(overlaps(pill(50, 100, 200), pill(50, 0, 50))).toBe(false);
  });
});

describe("placeLabel", () => {
  it("empty frame leaves the label on its anchor", () => {
    expect(placeLabel(pill(50), [], -1)).toEqual({ y0: 43, y1: 57, fits: true });
  });

  it("pushes up past a taken slot", () => {
    // blocker 43..57; label is 14 tall with a 2px gap -> 57 - 2 - 14 = 41
    expect(placeLabel(pill(50), [pill(50)], -1)).toEqual({ y0: 27, y1: 41, fits: true });
  });

  it("pushes down past a taken slot", () => {
    // blocker 43..57 -> 57 + 2 = 59
    expect(placeLabel(pill(50), [pill(50)], 1)).toEqual({ y0: 59, y1: 73, fits: true });
  });

  it("three labels on one anchor stack at a 16px pitch", () => {
    // the renderer places in order, reserving as it goes
    const taken: Rect[] = [];
    const ys: number[] = [];
    for (let k = 0; k < 3; k++) {
      const p = placeLabel(pill(50), taken, -1);
      expect(p.fits).toBe(true);
      ys.push(p.y0);
      taken.push({ x0: 100, x1: 200, y0: p.y0, y1: p.y1 });
    }
    // 43, then 43-16, then 27-16: pill height 14 + gap 2
    expect(ys).toEqual([43, 27, 11]);
  });

  it("ignores labels that do not share x", () => {
    expect(placeLabel(pill(50, 100, 200), [pill(50, 0, 60)], -1).y0).toBe(43);
  });

  it("uses a gap that is big enough rather than overshooting", () => {
    // blockers 10..20 and 40..60; label wants 5..19, so only the first blocks.
    // Past it: 22..36, which sits inside the free 20..40 band.
    const want: Rect = { x0: 100, x1: 200, y0: 5, y1: 19 };
    const taken: Rect[] = [
      { x0: 100, x1: 200, y0: 10, y1: 20 },
      { x0: 100, x1: 200, y0: 40, y1: 60 },
    ];
    expect(placeLabel(want, taken, 1)).toEqual({ y0: 22, y1: 36, fits: true });
  });

  it("skips a gap that is too small", () => {
    // blockers 10..20 and 30..40 leave only 10px between them; the label needs
    // 14 plus a gap, so it has to clear the second one: 40 + 2 = 42.
    const want: Rect = { x0: 100, x1: 200, y0: 5, y1: 19 };
    const taken: Rect[] = [
      { x0: 100, x1: 200, y0: 10, y1: 20 },
      { x0: 100, x1: 200, y0: 30, y1: 40 },
    ];
    expect(placeLabel(want, taken, 1)).toEqual({ y0: 42, y1: 56, fits: true });
  });

  it("does not depend on the order of taken", () => {
    const want: Rect = { x0: 100, x1: 200, y0: 5, y1: 19 };
    const a: Rect = { x0: 100, x1: 200, y0: 10, y1: 20 };
    const b: Rect = { x0: 100, x1: 200, y0: 12, y1: 14 };
    expect(placeLabel(want, [a, b], 1).y0).toBe(22);
    expect(placeLabel(want, [b, a], 1).y0).toBe(22);
  });

  it("reports a label pushed past the top edge as not fitting", () => {
    // lands at 27..41, which is above minY
    const p = placeLabel(pill(50), [pill(50)], -1, { minY: 30 });
    expect(p).toEqual({ y0: 27, y1: 41, fits: false });
  });

  it("reports a label pushed past the bottom edge as not fitting", () => {
    const p = placeLabel(pill(50), [pill(50)], 1, { maxY: 70 });
    expect(p).toEqual({ y0: 59, y1: 73, fits: false });
  });

  it("an unobstructed label already outside the bounds does not fit", () => {
    expect(placeLabel(pill(10), [], -1, { minY: 20 })).toEqual({ y0: 3, y1: 17, fits: false });
  });

  it("stacks labels of different heights against each other", () => {
    // a 14-tall pill holds 93..107; an 11-tall TPO label wanting the same
    // centre clears it upward past the pill's top: 93 - 2 - 11 = 80
    const pillBox: Rect = { x0: 100, x1: 200, y0: 93, y1: 107 };
    const want: Rect = { x0: 100, x1: 200, y0: 94.5, y1: 105.5 };
    expect(placeLabel(want, [pillBox], -1)).toEqual({ y0: 80, y1: 91, fits: true });
  });

  it("stacks two 11px labels at a 13px pitch", () => {
    const taken: Rect[] = [];
    const ys: number[] = [];
    for (let k = 0; k < 3; k++) {
      // an 11-tall label centred on 100
      const p = placeLabel({ x0: 100, x1: 160, y0: 94.5, y1: 105.5 }, taken, -1);
      ys.push(p.y0);
      taken.push({ x0: 100, x1: 160, y0: p.y0, y1: p.y1 });
    }
    // 11 tall + 2 gap
    expect(ys).toEqual([94.5, 81.5, 68.5]);
  });

  it("honours a custom gap", () => {
    // blocker 43..57, gap 6 -> 57 + 6 = 63
    expect(placeLabel(pill(50), [pill(50)], 1, { gap: 6 }).y0).toBe(63);
  });
});
