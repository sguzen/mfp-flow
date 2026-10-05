/**
 * Decimal-safe price handling.
 *
 * Every price is converted once, at the edge, from the API's decimal string
 * into an integer number of "units" (1 unit = 1e-8 of the quote currency).
 * All bucketing and comparisons then use exact integer arithmetic on those
 * units; floats are never used as map keys. A float64 holds integers exactly
 * up to 2^53, so prices up to ~90,000,000 are safe at 8 decimals.
 */

export const PRICE_DP = 8;
export const PRICE_SCALE = 100_000_000;

const DEC_RE = /^(-)?(\d+)(?:\.(\d*))?$/;

/** Parse a decimal string ("86163.90", "0.0000123", "30775") into integer units. Half-up rounding beyond 8 dp. */
export function parseUnits(s: string): number {
  const m = DEC_RE.exec(s.trim());
  if (!m) throw new Error(`invalid decimal: ${JSON.stringify(s)}`);
  let frac = m[3] ?? "";
  let roundUp = 0;
  if (frac.length > PRICE_DP) {
    roundUp = frac.charCodeAt(PRICE_DP) >= 53 /* '5' */ ? 1 : 0;
    frac = frac.slice(0, PRICE_DP);
  }
  frac = frac.padEnd(PRICE_DP, "0");
  const intPart = Number(m[2]);
  const v = intPart * PRICE_SCALE + Number(frac) + roundUp;
  if (!Number.isSafeInteger(v)) throw new Error(`price out of safe range: ${s}`);
  return m[1] ? -v : v;
}

/** Convert a JSON number (e.g. marketStats.markPx) to units. Only for display-grade values. */
export function unitsFromNumber(n: number): number {
  return Math.round(n * PRICE_SCALE);
}

/** Format units with `dp` decimals (truncating extra digits, exact for tick-aligned values). */
export function formatUnits(u: number, dp: number): string {
  const neg = u < 0;
  const s = String(Math.abs(Math.round(u))).padStart(PRICE_DP + 1, "0");
  const int = s.slice(0, s.length - PRICE_DP);
  const frac = s.slice(s.length - PRICE_DP, s.length - PRICE_DP + Math.max(0, dp));
  const intGrouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + intGrouped + (dp > 0 ? "." + frac : "");
}

/** Units → float price (display / notional maths only). */
export function unitsToNumber(u: number): number {
  return u / PRICE_SCALE;
}

/** Exact floor division for integers (works for negatives). */
export function floorDiv(a: number, b: number): number {
  const r = a % b;
  const q = (a - r) / b;
  return r !== 0 && (r < 0) !== (b < 0) ? q - 1 : q;
}

/** Index of the bucket containing `units` for a bucket size of `bucketUnits`. Bucket k covers [k*b, (k+1)*b). */
export function bucketOf(units: number, bucketUnits: number): number {
  return floorDiv(units, bucketUnits);
}

export function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

/** Number of decimals needed to display multiples of `units` exactly. */
export function decimalsFor(units: number): number {
  let dp = PRICE_DP;
  let u = Math.abs(units);
  if (u === 0) return 0;
  while (dp > 0 && u % 10 === 0) {
    u /= 10;
    dp--;
  }
  return dp;
}

const MANTISSAS = [1, 2, 2.5, 5];

/** Smallest "nice" number (1, 2, 2.5, 5 × 10^k) that is >= x. */
export function niceCeil(x: number): number {
  if (!(x > 0)) return 1;
  let exp = Math.floor(Math.log10(x));
  for (let guard = 0; guard < 4; guard++, exp++) {
    for (const m of MANTISSAS) {
      const v = Number((m * Math.pow(10, exp)).toPrecision(12));
      if (v >= x * (1 - 1e-12)) return v;
    }
  }
  return Math.pow(10, exp);
}

/**
 * Storage granularity for live footprints: a power of ten ≈ 0.1 bp of price,
 * but never finer than the largest power of ten dividing the market tick.
 * Every selectable row size is an integer multiple of it, and nested floor
 * division keeps re-bucketing exact: floor(floor(p/f)/(r/f)) = floor(p/r).
 * BTC ~86k (tick 0.1) → 0.1, NAS100 ~30.8k (tick 1) → 1, GOLD ~4.15k (tick 0.1) → 0.1.
 */
export function fineUnitsFor(refPriceUnits: number, tickUnits = 1): number {
  const ref = unitsToNumber(Math.abs(refPriceUnits));
  let u = 1;
  if (ref > 0) {
    const e = Math.floor(Math.log10(ref * 1e-5));
    u = Math.max(1, Math.round(Math.pow(10, e) * PRICE_SCALE));
  }
  return Math.max(u, pow10Divisor(tickUnits));
}

/** Largest power of ten (in units) dividing `units`. */
export function pow10Divisor(units: number): number {
  let p = 1;
  const a = Math.abs(Math.round(units));
  if (a === 0) return 1;
  while (a % (p * 10) === 0 && p < PRICE_SCALE * 1e6) p *= 10;
  return p;
}

export interface BucketChoice {
  /** default row size (units) */
  defaultUnits: number;
  /** selectable row sizes (units), ascending; each a multiple of the tick and of fineUnits */
  options: number[];
  /** storage granularity (see fineUnitsFor) */
  fineUnits: number;
}

/**
 * Choose row sizes for a market from a reference price and the observed tick
 * (gcd of observed prices, in units).
 * Default ≈ 1 basis point of price rounded up to a nice number
 * (BTC ~86k → 10, NAS100 ~30.8k → 5, GOLD ~4.15k → 0.5, SP500 ~6.8k → 1).
 */
export function chooseBuckets(refPriceUnits: number, tickUnits: number): BucketChoice {
  const tick = Math.max(1, Math.round(tickUnits));
  const fine = fineUnitsFor(refPriceUnits, tick);
  const ref = unitsToNumber(refPriceUnits);
  let def = Math.round(niceCeil(ref * 1e-4) * PRICE_SCALE);
  const lo = def / 10;
  const hi = def * 20;
  const cands = new Set<number>();
  const e0 = Math.floor(Math.log10(lo / PRICE_SCALE)) - 1;
  const e1 = Math.ceil(Math.log10(hi / PRICE_SCALE)) + 1;
  for (let e = e0; e <= e1; e++) {
    for (const m of MANTISSAS) {
      const v = Math.round(Number((m * Math.pow(10, e)).toPrecision(12)) * PRICE_SCALE);
      if (v >= lo && v <= hi && v >= 1) cands.add(v);
    }
  }
  let options = [...cands].filter((v) => v % tick === 0 && v % fine === 0).sort((a, b) => a - b);
  if (options.length === 0) {
    const base = tick % fine === 0 ? tick : tick * fine / gcd(tick, fine);
    options = [base, base * 2, base * 5, base * 10];
  }
  if (!options.includes(def)) def = options.find((v) => v >= def) ?? options[options.length - 1];
  return { defaultUnits: def, options, fineUnits: fine };
}

/** gcd of a set of price units — the effective tick observed in the data. */
export function inferTick(prices: Iterable<number>): number {
  let g = 0;
  for (const p of prices) {
    if (p === 0) continue;
    g = g === 0 ? Math.abs(p) : gcd(g, p);
    if (g === 1) break;
  }
  return g || 1;
}
