import { describe, expect, it } from "vitest";
import { DevelopingProfile, pocRow, profileFromVolumes, valueArea } from "../src/analytics/profile";

describe("POC", () => {
  it("highest volume row", () => {
    expect(pocRow(profileFromVolumes({ 1: 5, 2: 10, 3: 7 }))).toBe(2);
  });
  it("tie -> row closest to the profile centre", () => {
    // rows 1..6, centre 3.5: row 1 is 2.5 away, row 4 is 0.5 away
    expect(pocRow(profileFromVolumes({ 1: 30, 2: 10, 3: 10, 4: 30, 5: 10, 6: 10 }))).toBe(4);
  });
  it("tie equidistant -> lower row", () => {
    expect(pocRow(profileFromVolumes({ 1: 10, 2: 30, 3: 20, 4: 30, 5: 10 }))).toBe(2);
  });
  it("empty profile -> null", () => {
    expect(pocRow(profileFromVolumes({}))).toBeNull();
    expect(valueArea(profileFromVolumes({}))).toBeNull();
  });
});

describe("value area (70%, expand two rows at a time)", () => {
  it("hand-computed example", () => {
    // total 275, target 192.5
    // POC row 5 (100). up(6,7)=80 vs dn(4,3)=60 -> up, acc 180
    // up(8,9)=20 vs dn(4,3)=60 -> dn, acc 240 >= 192.5 -> VA rows 3..7
    const p = profileFromVolumes({ 1: 5, 2: 10, 3: 20, 4: 40, 5: 100, 6: 50, 7: 30, 8: 15, 9: 5 });
    const va = valueArea(p)!;
    expect(p.total).toBe(275);
    expect(va.poc).toBe(5);
    expect(va.val).toBe(3);
    expect(va.vah).toBe(7);
    expect(va.volume).toBe(240);
  });
  it("equal pairs -> both added", () => {
    // POC 3 (50); up(4,5)=30 == dn(2,1)=30 -> both: acc 110
    const va = valueArea(profileFromVolumes({ 1: 10, 2: 20, 3: 50, 4: 20, 5: 10 }))!;
    expect([va.val, va.vah, va.volume]).toEqual([1, 5, 110]);
  });
  it("POC at the bottom edge expands only upwards", () => {
    // total 160, target 112; POC 1 (100) + (2,3)=50 -> 150
    const va = valueArea(profileFromVolumes({ 1: 100, 2: 30, 3: 20, 4: 10 }))!;
    expect([va.val, va.vah, va.volume]).toEqual([1, 3, 150]);
  });
  it("single remaining row on one side is compared as a pair", () => {
    // total 190, target 133; POC 2 (100); up(3,4)=40 vs dn(1)=50 -> dn, acc 150
    const va = valueArea(profileFromVolumes({ 1: 50, 2: 100, 3: 20, 4: 20 }))!;
    expect([va.val, va.vah, va.volume]).toEqual([1, 2, 150]);
    // total 170, target 119; up(3,4)=40 vs dn(1)=30 -> up, acc 140
    const vb = valueArea(profileFromVolumes({ 1: 30, 2: 100, 3: 20, 4: 20 }))!;
    expect([vb.val, vb.vah, vb.volume]).toEqual([2, 4, 140]);
  });
  it("zero rows inside the range still count as rows", () => {
    // rows 1..7, row 4 empty. total 100, target 70.
    // POC 6 (40). up(7)=10 vs dn(5,4)=15 -> dn: acc 55, dn=4
    // up(7)=10 vs dn(3,2)=5+10=15 -> dn: acc 70 >= 70 -> VA 2..6
    const va = valueArea(profileFromVolumes({ 1: 20, 2: 10, 3: 5, 4: 0, 5: 15, 6: 40, 7: 10 }))!;
    expect([va.poc, va.val, va.vah, va.volume]).toEqual([6, 2, 6, 70]);
  });
  it("whole profile when pct = 1", () => {
    const va = valueArea(profileFromVolumes({ 1: 1, 2: 2, 3: 3 }), 1)!;
    expect([va.val, va.vah]).toEqual([1, 3]);
  });
});

describe("developing POC", () => {
  it("tracks the running POC with the same tie-break", () => {
    const d = new DevelopingProfile();
    d.add(10, 5);
    expect(d.poc()).toBe(10);
    d.add(12, 7);
    expect(d.poc()).toBe(12);
    d.add(10, 2); // 10:7, 12:7, range 10..12 centre 11 -> equidistant -> lower
    expect(d.poc()).toBe(10);
    d.add(14, 1); // range 10..14 centre 12 -> 12 wins the tie
    expect(d.poc()).toBe(12);
  });
});

describe("mergeProfiles", () => {
  it("adds row volumes across sessions and keeps real/estimated split", async () => {
    const { mergeProfiles, profileFromRows, valueArea } = await import("../src/analytics/profile");
    const a = profileFromRows(new Map([[10, { b: 2, s: 1, e: 0 }], [11, { b: 0, s: 0, e: 4 }]]));
    const b = profileFromRows(new Map([[11, { b: 1, s: 1, e: 0 }], [13, { b: 0, s: 0, e: 3 }]]));
    const c = mergeProfiles([a, b]);
    expect([c.lo, c.hi]).toEqual([10, 13]);
    expect(Array.from(c.vol)).toEqual([3, 6, 0, 3]);
    expect(Array.from(c.buy)).toEqual([2, 1, 0, 0]);
    expect(Array.from(c.est)).toEqual([0, 4, 0, 3]);
    expect(c.total).toBe(12);
    // POC 11 (6); target 8.4: up pair 12+13 = 3, down 10 = 3 -> equal -> both -> 12 => VA 10..13
    expect(valueArea(c)).toMatchObject({ poc: 11, val: 10, vah: 13 });
  });
});
