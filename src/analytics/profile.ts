/**
 * Volume profile + value area.
 *
 * A profile is a dense array of row volumes from `lo` (lowest row index) to
 * `hi` inclusive; zero rows inside the range are kept because they matter for
 * the value-area walk and for low-volume nodes.
 */

export interface Profile {
  /** lowest row index */
  lo: number;
  /** highest row index */
  hi: number;
  /** total volume per row, index i -> row lo+i */
  vol: Float64Array;
  /** real aggressor buy / sell volume per row (0 for estimated) */
  buy: Float64Array;
  sell: Float64Array;
  /** estimated (side-unknown) volume per row */
  est: Float64Array;
  total: number;
}

export interface RowAccum {
  b: number;
  s: number;
  e: number;
}

export function emptyProfile(): Profile {
  const z = new Float64Array(0);
  return { lo: 0, hi: -1, vol: z, buy: z, sell: z, est: z, total: 0 };
}

/** Build a dense profile from sparse row accumulators. */
export function profileFromRows(rows: Map<number, RowAccum>): Profile {
  if (rows.size === 0) return emptyProfile();
  let lo = Infinity;
  let hi = -Infinity;
  for (const k of rows.keys()) {
    if (k < lo) lo = k;
    if (k > hi) hi = k;
  }
  const n = hi - lo + 1;
  const p: Profile = {
    lo,
    hi,
    vol: new Float64Array(n),
    buy: new Float64Array(n),
    sell: new Float64Array(n),
    est: new Float64Array(n),
    total: 0,
  };
  for (const [k, r] of rows) {
    const i = k - lo;
    p.buy[i] = r.b;
    p.sell[i] = r.s;
    p.est[i] = r.e;
    p.vol[i] = r.b + r.s + r.e;
    p.total += p.vol[i];
  }
  return p;
}

/** Convenience for tests: build a profile from {row: volume}. */
export function profileFromVolumes(v: Record<number, number>): Profile {
  const m = new Map<number, RowAccum>();
  for (const [k, x] of Object.entries(v)) m.set(Number(k), { b: 0, s: 0, e: x });
  return profileFromRows(m);
}

/**
 * Point of control: row with the highest volume.
 * Ties: the row closest to the middle of the profile range wins
 * (Market Profile convention); if still tied, the lower row.
 * Returns the row index, or null for an empty profile.
 */
export function pocRow(p: Profile): number | null {
  const n = p.hi - p.lo + 1;
  if (n <= 0 || p.total <= 0) return null;
  let best = -1;
  let bestV = -1;
  const mid2 = p.lo + p.hi; // 2 × midpoint, keeps it an integer
  for (let i = 0; i < n; i++) {
    const v = p.vol[i];
    if (v > bestV) {
      best = i;
      bestV = v;
    } else if (v === bestV) {
      const dNew = Math.abs(2 * (p.lo + i) - mid2);
      const dOld = Math.abs(2 * (p.lo + best) - mid2);
      if (dNew < dOld) best = i;
    }
  }
  return p.lo + best;
}

export interface ValueArea {
  poc: number;
  /** highest row inside the value area */
  vah: number;
  /** lowest row inside the value area */
  val: number;
  /** volume inside the value area */
  volume: number;
  /** fraction of total actually captured */
  pct: number;
}

/**
 * Value area by the classic CBOT "expand from POC two rows at a time" method:
 *
 *  1. Start with the POC row.
 *  2. Look at the next two rows above the current VA and the next two below.
 *     Add the pair with the larger combined volume.
 *     If the pairs are equal, add both.
 *     If one side has no rows left, the pair from the other side is added.
 *     If only one row remains on a side, its "pair" is that single row.
 *  3. Repeat until the VA holds >= `pct` of the total volume.
 */
export function valueArea(p: Profile, pct = 0.7): ValueArea | null {
  const poc = pocRow(p);
  if (poc === null) return null;
  const target = p.total * pct;
  let up = poc; // highest included row
  let dn = poc; // lowest included row
  let acc = p.vol[poc - p.lo];
  const v = (row: number) => (row >= p.lo && row <= p.hi ? p.vol[row - p.lo] : 0);
  while (acc < target - 1e-12 * p.total && (up < p.hi || dn > p.lo)) {
    const upRows = Math.min(2, p.hi - up);
    const dnRows = Math.min(2, dn - p.lo);
    const upSum = upRows >= 1 ? v(up + 1) + (upRows === 2 ? v(up + 2) : 0) : -1;
    const dnSum = dnRows >= 1 ? v(dn - 1) + (dnRows === 2 ? v(dn - 2) : 0) : -1;
    if (upRows === 0) {
      dn -= dnRows;
      acc += dnSum;
    } else if (dnRows === 0) {
      up += upRows;
      acc += upSum;
    } else if (upSum > dnSum) {
      up += upRows;
      acc += upSum;
    } else if (dnSum > upSum) {
      dn -= dnRows;
      acc += dnSum;
    } else {
      up += upRows;
      dn -= dnRows;
      acc += upSum + dnSum;
    }
  }
  return { poc, vah: up, val: dn, volume: acc, pct: p.total > 0 ? acc / p.total : 0 };
}

/**
 * Incremental profile for developing POC: add row volumes bar by bar and read
 * the POC after each bar. Uses the same tie-breaking as pocRow().
 */
export class DevelopingProfile {
  private rows = new Map<number, number>();
  private lo = Infinity;
  private hi = -Infinity;
  private maxV = 0;

  add(row: number, v: number): void {
    if (v <= 0) return;
    const nv = (this.rows.get(row) ?? 0) + v;
    this.rows.set(row, nv);
    if (row < this.lo) this.lo = row;
    if (row > this.hi) this.hi = row;
    if (nv > this.maxV) this.maxV = nv;
  }

  /** POC row with centre tie-break; O(rows) only over rows holding the max. */
  poc(): number | null {
    if (this.rows.size === 0) return null;
    const mid2 = this.lo + this.hi;
    let best: number | null = null;
    for (const [k, v] of this.rows) {
      if (v !== this.maxV) continue;
      if (best === null) best = k;
      else {
        const dNew = Math.abs(2 * k - mid2);
        const dOld = Math.abs(2 * best - mid2);
        if (dNew < dOld || (dNew === dOld && k < best)) best = k;
      }
    }
    return best;
  }
}

/** Merge several profiles (same row size) into one composite profile. */
export function mergeProfiles(profiles: Profile[]): Profile {
  const rows = new Map<number, RowAccum>();
  for (const p of profiles) {
    for (let i = 0; i < p.hi - p.lo + 1; i++) {
      if (p.vol[i] <= 0) continue;
      const r = p.lo + i;
      const a = rows.get(r) ?? { b: 0, s: 0, e: 0 };
      a.b += p.buy[i];
      a.s += p.sell[i];
      a.e += p.est[i];
      rows.set(r, a);
    }
  }
  return profileFromRows(rows);
}
