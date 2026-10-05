/** Canvas palette, read from CSS custom properties so light/dark live in one place (style.css). */
export interface Palette {
  bg: string;
  panel: string;
  grid: string;
  gridStrong: string;
  text: string;
  dim: string;
  faint: string;
  buy: string;
  sell: string;
  buyText: string;
  sellText: string;
  est: string;
  poc: string;
  va: string;
  vaFill: string;
  prior: string;
  naked: string;
  cvd: string;
  ctxMark: string;
  cross: string;
  session: string;
  profile: string;
  profileVa: string;
}

const KEYS: Array<[keyof Palette, string]> = [
  ["bg", "--c-bg"],
  ["panel", "--c-panel"],
  ["grid", "--c-grid"],
  ["gridStrong", "--c-grid-strong"],
  ["text", "--c-text"],
  ["dim", "--c-dim"],
  ["faint", "--c-faint"],
  ["buy", "--c-buy"],
  ["sell", "--c-sell"],
  ["buyText", "--c-buy-text"],
  ["sellText", "--c-sell-text"],
  ["est", "--c-est"],
  ["poc", "--c-poc"],
  ["va", "--c-va"],
  ["vaFill", "--c-va-fill"],
  ["prior", "--c-prior"],
  ["naked", "--c-naked"],
  ["cvd", "--c-cvd"],
  ["ctxMark", "--c-ctx"],
  ["cross", "--c-cross"],
  ["session", "--c-session"],
  ["profile", "--c-profile"],
  ["profileVa", "--c-profile-va"],
];

export function readPalette(el: Element = document.documentElement): Palette {
  const cs = getComputedStyle(el);
  const p = {} as Palette;
  for (const [k, v] of KEYS) p[k] = cs.getPropertyValue(v).trim() || "#888";
  return p;
}

/** Parse #rrggbb into an rgba() string with the given alpha. */
export function alpha(hex: string, a: number): string {
  const h = hex.replace("#", "");
  if (h.length !== 6) return hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
}

export function hatchPattern(ctx: CanvasRenderingContext2D, color: string, dpr: number): CanvasPattern | null {
  const s = Math.max(4, Math.round(5 * dpr));
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d");
  if (!g) return null;
  g.strokeStyle = color;
  g.lineWidth = Math.max(1, dpr);
  g.beginPath();
  g.moveTo(-1, s + 1);
  g.lineTo(s + 1, -1);
  g.stroke();
  const pat = ctx.createPattern(c, "repeat");
  if (pat && typeof DOMMatrix !== "undefined") pat.setTransform(new DOMMatrix().scale(1 / dpr, 1 / dpr));
  return pat;
}
