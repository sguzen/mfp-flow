/**
 * Canvas renderer for the footprint, session profile, delta strip and CVD pane.
 * Reads a ChartModel; owns only view state (zoom, pan, crosshair).
 *
 *  ┌───────────────────────────── plot ───────────────────────────┬─ profile ─┬ axis ┐
 *  │ source strip (real / estimated per bar) + session labels     │           │      │
 *  │ footprint cells + candles + levels + context markers         │  session  │ price│
 *  ├──────────────────────────────────────────────────────────────┤  profile  │      │
 *  │ per-bar delta / volume                                       │           │      │
 *  ├──────────────────────────────────────────────────────────────┤           │      │
 *  │ CVD (resets each session)                                    │           │      │
 *  ├──────────────────────────────────────────────────────────────┴───────────┴──────┤
 *  │ time axis                                                                        │
 *  └──────────────────────────────────────────────────────────────────────────────────┘
 */
import { decimalsFor, formatUnits, niceCeil, PRICE_SCALE } from "../analytics/price";
import { barDelta, type SessionStats } from "../analytics/series";
import { barSource } from "../analytics/types";
import { tpoLetter } from "../analytics/tpo";
import type { ChartModel } from "../model";
import { fmtDate, fmtDateTime, fmtSigned, fmtTime, fmtVol, type TimeZoneMode } from "./format";
import { placeLabel, type Rect } from "./stack";
import { alpha, hatchPattern, readPalette, type Palette } from "./theme";

export interface ChartMeta {
  lastPrice: number | null;
  tick: number;
  realSince: number | null;
  tz: TimeZoneMode;
  title: string;
  subtitle: string;
  showMarkers: boolean;
  showDivergence: boolean;
  estDelta: boolean;
}

export interface AccountLine {
  /** price in integer units (1e-8), like everything else the chart draws */
  price: number;
  kind: "entry" | "stop" | "target" | "liquidation" | "daily-breach" | "drawdown-breach";
  label: string;
  tone: "neutral" | "good" | "bad" | "warn";
}

interface Layout {
  w: number;
  h: number;
  plotX0: number;
  plotX1: number;
  profX0: number;
  profX1: number;
  axisX0: number;
  axisX1: number;
  stripY0: number;
  mainY0: number;
  mainY1: number;
  deltaY0: number;
  deltaY1: number;
  cvdY0: number;
  cvdY1: number;
  timeY0: number;
  timeY1: number;
}

/** box height reserved for a 9px TPO extreme label, 2px of padding included */
const TPO_LAB_H = 11;
const RIGHT_PAD = 36;
const MONO = "'JetBrains Mono', 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace";
const SANS = "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";

export class FootprintChart {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tip: HTMLDivElement;
  private latestBtn: HTMLButtonElement;
  private model: ChartModel | null = null;
  private meta: ChartMeta = {
    lastPrice: null,
    tick: 1,
    realSince: null,
    tz: "UTC",
    title: "",
    subtitle: "",
    showMarkers: true,
    showDivergence: true,
    estDelta: false,
  };
  private pal: Palette;
  private hatch: CanvasPattern | null = null;
  private hatchProfile: CanvasPattern | null = null;
  private dpr = 1;
  private L!: Layout;
  private raf = 0;
  private lastN = 0;
  private lastRow = 0;
  /** context-label boxes already placed this frame, so they can stack instead of overlap */
  private taken: Rect[] = [];
  /** account overlay lines (price units), drawn by the extension panel */
  private accountLines: AccountLine[] = [];

  // view state
  barW = 84;
  scroll = 0;
  follow = true;
  autoY = true;
  upp = 1; // price units per css pixel
  centerU = 0;

  // pointer
  private mouse: { x: number; y: number } | null = null;
  private drag: { x: number; y: number; scroll: number; centerU: number; upp: number; mode: "pan" | "yzoom"; moved: boolean } | null = null;
  private onViewChange: (() => void) | null = null;

  constructor(private host: HTMLElement) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "chart-canvas";
    this.canvas.setAttribute("role", "img");
    this.canvas.setAttribute("aria-label", "Footprint chart with session volume profile and cumulative delta");
    this.canvas.tabIndex = 0;
    host.appendChild(this.canvas);
    this.tip = document.createElement("div");
    this.tip.className = "chart-tip";
    host.appendChild(this.tip);
    this.latestBtn = document.createElement("button");
    this.latestBtn.className = "latest-btn";
    this.latestBtn.textContent = "Latest ⟶";
    this.latestBtn.title = "Scroll to the latest bar (double-click the chart to reset the view)";
    this.latestBtn.onclick = () => {
      this.scroll = 0;
      this.follow = true;
      this.autoY = true;
      this.request();
    };
    host.appendChild(this.latestBtn);
    const ctx = this.canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("canvas 2d unavailable");
    this.ctx = ctx;
    this.pal = readPalette();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(host);
    this.bindEvents();
  }

  setOnViewChange(fn: () => void) {
    this.onViewChange = fn;
  }

  setModel(m: ChartModel) {
    const n = m.bars.length;
    const row = m.settings.rowUnits;
    if (this.model && !this.follow && this.lastN && n > this.lastN && this.lastRow === row) this.scroll += n - this.lastN;
    if (this.lastRow && row !== this.lastRow) {
      // keep the same price per pixel ratio relative to rows
      this.upp *= row / this.lastRow;
    }
    if (!this.lastRow) this.upp = row / 18;
    this.lastN = n;
    this.lastRow = row;
    this.model = m;
    this.request();
  }

  setMeta(p: Partial<ChartMeta>) {
    this.meta = { ...this.meta, ...p };
    this.request();
  }

  /** Account overlay: entry / stop / target / liquidation / breach floors. */
  setAccountLines(lines: AccountLine[]) {
    this.accountLines = lines;
    this.request();
  }

  resetView(barW = 84) {
    this.barW = barW;
    this.scroll = 0;
    this.follow = true;
    this.autoY = true;
    this.request();
  }

  refreshTheme() {
    this.pal = readPalette();
    this.makePatterns();
    this.request();
  }

  /**
   * Re-render into an offscreen canvas at `scale` device pixels per CSS pixel,
   * for export. The crosshair is suppressed and the on-screen canvas is put
   * back exactly as it was, even if drawing throws.
   */
  snapshot(scale = 2): HTMLCanvasElement {
    const out = document.createElement("canvas");
    out.width = Math.round(this.L.w * scale);
    out.height = Math.round(this.L.h * scale);
    const prev = { dpr: this.dpr, w: this.canvas.width, h: this.canvas.height, mouse: this.mouse };
    try {
      this.dpr = scale;
      this.mouse = null;
      this.canvas.width = out.width;
      this.canvas.height = out.height;
      this.makePatterns();
      this.draw();
      out.getContext("2d")?.drawImage(this.canvas, 0, 0);
    } finally {
      this.dpr = prev.dpr;
      this.mouse = prev.mouse;
      this.canvas.width = prev.w;
      this.canvas.height = prev.h;
      this.makePatterns();
      this.draw();
    }
    return out;
  }

  private makePatterns() {
    this.hatch = hatchPattern(this.ctx, alpha(this.pal.est, 0.55), this.dpr);
    this.hatchProfile = hatchPattern(this.ctx, alpha(this.pal.est, 0.75), this.dpr);
  }

  private resize() {
    const r = this.host.getBoundingClientRect();
    const w = Math.max(320, Math.floor(r.width));
    const h = Math.max(260, Math.floor(r.height));
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = w + "px";
    this.canvas.style.height = h + "px";
    this.L = this.layout(w, h);
    this.makePatterns();
    this.request();
  }

  private layout(w: number, h: number): Layout {
    const axisW = w < 560 ? 62 : 76;
    const profW = w < 560 ? 64 : Math.round(Math.min(230, Math.max(120, w * 0.14)));
    const timeH = 22;
    const cvdH = Math.round(Math.min(150, Math.max(64, h * 0.17)));
    const deltaH = 34;
    const stripH = 16;
    const plotX1 = w - axisW - profW;
    return {
      w,
      h,
      plotX0: 0,
      plotX1,
      profX0: plotX1,
      profX1: plotX1 + profW,
      axisX0: plotX1 + profW,
      axisX1: w,
      stripY0: 0,
      mainY0: stripH,
      mainY1: h - timeH - cvdH - deltaH,
      deltaY0: h - timeH - cvdH - deltaH,
      deltaY1: h - timeH - cvdH,
      cvdY0: h - timeH - cvdH,
      cvdY1: h - timeH,
      timeY0: h - timeH,
      timeY1: h,
    };
  }

  request() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  // ---------- coordinate helpers ----------
  private get n() {
    return this.model?.bars.length ?? 0;
  }
  private xLeft(i: number): number {
    return this.L.plotX1 - RIGHT_PAD - (this.n - i - this.scroll) * this.barW;
  }
  private idxAt(x: number): number {
    return Math.floor(this.n - this.scroll - (this.L.plotX1 - RIGHT_PAD - x) / this.barW);
  }
  private get midY() {
    return (this.L.mainY0 + this.L.mainY1) / 2;
  }
  private yOf(u: number): number {
    return this.midY - (u - this.centerU) / this.upp;
  }
  private uOf(y: number): number {
    return this.centerU + (this.midY - y) * this.upp;
  }
  private visibleRange(): [number, number] {
    const n = this.n;
    const i0 = Math.max(0, this.idxAt(this.L.plotX0) - 1);
    const i1 = Math.min(n - 1, this.idxAt(this.L.plotX1) + 1);
    return [i0, i1];
  }

  private clampScroll() {
    const n = this.n;
    const plotW = this.L.plotX1 - this.L.plotX0;
    const minScroll = -Math.floor((plotW * 0.6) / this.barW);
    const maxScroll = Math.max(0, n - 2);
    this.scroll = Math.max(minScroll, Math.min(maxScroll, this.scroll));
  }

  private autoFitY() {
    const m = this.model;
    if (!m || !this.n) {
      if (this.meta.lastPrice) this.centerU = this.meta.lastPrice;
      return;
    }
    const [i0, i1] = this.visibleRange();
    let hi = -Infinity;
    let lo = Infinity;
    for (let i = i0; i <= i1; i++) {
      const b = m.bars[i];
      if (b.h > hi) hi = b.h;
      if (b.l < lo) lo = b.l;
    }
    if (!Number.isFinite(hi)) {
      const b = m.bars[this.n - 1];
      hi = b.h;
      lo = b.l;
    }
    const row = m.settings.rowUnits;
    const H = this.L.mainY1 - this.L.mainY0;
    const range = Math.max(hi - lo + row, row * 6);
    this.upp = Math.max(range / (H * 0.84), row / 30);
    this.centerU = (hi + lo + row) / 2;
  }

  // ---------- drawing ----------
  private draw() {
    const ctx = this.ctx;
    const L = this.L;
    const P = this.pal;
    const m = this.model;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = P.bg;
    ctx.fillRect(0, 0, L.w, L.h);
    this.latestBtn.classList.toggle("show", !this.follow || this.scroll > 0.5);
    if (!m || !this.n) {
      this.drawEmpty();
      return;
    }
    if (this.follow) this.scroll = 0;
    this.clampScroll();
    if (this.autoY) this.autoFitY();

    const [i0, i1] = this.visibleRange();
    this.taken.length = 0;
    const row = m.settings.rowUnits;
    const rowH = row / this.upp;

    // ---- main plot
    ctx.save();
    ctx.beginPath();
    ctx.rect(L.plotX0, L.mainY0, L.plotX1 - L.plotX0, L.mainY1 - L.mainY0);
    ctx.clip();
    const view = m.settings.view;
    this.drawGrid(i0, i1);
    if (view === "profiles") this.drawSessionHistograms(i0, i1);
    this.drawSessionBands(i0, i1);
    this.drawCompositeLevels();
    this.drawReferenceLevels();
    if (view === "tpo") {
      this.drawTpo(i0, i1, rowH);
    } else {
      let maxCell = 0;
      for (let i = i0; i <= i1; i++) maxCell = Math.max(maxCell, m.barInfo(m.bars[i]).maxCell);
      for (let i = i0; i <= i1; i++) this.drawBar(i, rowH, maxCell);
      if (view === "footprint") this.drawDevelopingPoc(i0, i1);
    }
    if (this.meta.showMarkers && view === "footprint") this.drawContextMarkers();
    this.drawAccountLines();
    if (this.meta.showDivergence && view !== "tpo") this.drawDivergencesPrice(i0, i1);
    this.drawLastPrice();
    ctx.restore();

    this.drawSourceStrip(i0, i1);
    this.drawSessionSeparators(i0, i1);
    this.drawDeltaStrip(i0, i1);
    this.drawCvd(i0, i1);
    this.drawProfile();
    this.drawPriceAxis();
    this.drawTimeAxis(i0, i1);
    this.drawFrame();
    this.drawLegend();
    this.drawCrosshair();
  }

  private drawEmpty() {
    const ctx = this.ctx;
    ctx.fillStyle = this.pal.dim;
    ctx.font = `13px ${SANS}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Connecting to MFP market data…", this.L.w / 2, this.L.h / 2);
  }

  private drawFrame() {
    const ctx = this.ctx;
    const L = this.L;
    ctx.strokeStyle = this.pal.gridStrong;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const hl = (y: number, x0: number, x1: number) => {
      ctx.moveTo(x0, Math.round(y) + 0.5);
      ctx.lineTo(x1, Math.round(y) + 0.5);
    };
    const vl = (x: number, y0: number, y1: number) => {
      ctx.moveTo(Math.round(x) + 0.5, y0);
      ctx.lineTo(Math.round(x) + 0.5, y1);
    };
    hl(L.mainY1, L.plotX0, L.axisX1);
    hl(L.deltaY1, L.plotX0, L.axisX1);
    hl(L.cvdY1, L.plotX0, L.axisX1);
    vl(L.profX0, 0, L.timeY0);
    vl(L.axisX0, 0, L.timeY1);
    ctx.stroke();
  }

  private priceDp(step?: number): number {
    const t = decimalsFor(this.meta.tick || 1);
    return step !== undefined ? Math.min(t, decimalsFor(step)) : t;
  }

  private gridStep(): number {
    const m = this.model!;
    const row = m.settings.rowUnits;
    const minPx = 46;
    const priceStep = niceCeil((minPx * this.upp) / PRICE_SCALE);
    let step = Math.max(row, Math.round(priceStep * PRICE_SCALE));
    if (step % row !== 0) step = Math.ceil(step / row) * row;
    return step;
  }

  private drawGrid(i0: number, i1: number) {
    const ctx = this.ctx;
    const L = this.L;
    const step = this.gridStep();
    const uTop = this.uOf(L.mainY0);
    const uBot = this.uOf(L.mainY1);
    ctx.strokeStyle = this.pal.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let u = Math.floor(uBot / step) * step; u <= uTop; u += step) {
      const y = Math.round(this.yOf(u)) + 0.5;
      ctx.moveTo(L.plotX0, y);
      ctx.lineTo(L.plotX1, y);
    }
    // vertical grid at time labels
    for (const i of this.timeLabelIdx(i0, i1)) {
      const x = Math.round(this.xLeft(i)) + 0.5;
      ctx.moveTo(x, L.mainY0);
      ctx.lineTo(x, L.mainY1);
    }
    ctx.stroke();
  }

  /** Value-area band, POC, VAH/VAL for each visible session. */
  private drawSessionBands(i0: number, i1: number) {
    const m = this.model!;
    const ctx = this.ctx;
    const P = this.pal;
    const row = m.settings.rowUnits;
    const last = m.sessions.length - 1;
    for (let k = 0; k < m.sessions.length; k++) {
      const s = m.sessions[k];
      const va = m.settings.view === "tpo" ? m.tpo[k]?.va : s.va;
      if (s.i1 < i0 || s.i0 > i1 || !va) continue;
      const x0 = this.xLeft(s.i0);
      const x1 = k === last ? this.L.plotX1 : this.xLeft(s.i1) + this.barW;
      const yH = this.yOf((va.vah + 1) * row);
      const yL = this.yOf(va.val * row);
      ctx.fillStyle = P.vaFill;
      ctx.fillRect(x0, yH, x1 - x0, yL - yH);
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.strokeStyle = alpha(P.va, 0.55);
      ctx.beginPath();
      ctx.moveTo(x0, Math.round(yH) + 0.5);
      ctx.lineTo(x1, Math.round(yH) + 0.5);
      ctx.moveTo(x0, Math.round(yL) + 0.5);
      ctx.lineTo(x1, Math.round(yL) + 0.5);
      ctx.stroke();
      if (m.settings.view === "tpo") continue; // the TPO POC row is highlighted instead
      const yP = Math.round(this.yOf((va.poc + 0.5) * row)) + 0.5;
      ctx.strokeStyle = alpha(P.poc, 0.8);
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(x0, yP);
      ctx.lineTo(x1, yP);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  /** Prior-session POC/VAH/VAL and naked POCs, extended to the right edge. */
  private drawReferenceLevels() {
    const m = this.model!;
    const ctx = this.ctx;
    const P = this.pal;
    const L = this.L;
    const row = m.settings.rowUnits;
    const cur = m.sessions[m.sessions.length - 1];
    const prior = m.ctx.prior;
    ctx.font = `10px ${MONO}`;
    ctx.textBaseline = "bottom";
    ctx.textAlign = "right";
    const line = (u: number, x0: number, color: string, dash: number[], label: string) => {
      const y = Math.round(this.yOf(u)) + 0.5;
      if (y < L.mainY0 - 2 || y > L.mainY1 + 2) return;
      ctx.strokeStyle = color;
      ctx.setLineDash(dash);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.max(L.plotX0, x0), y);
      ctx.lineTo(L.plotX1, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.fillText(label, L.plotX1 - 4, y - 2);
    };
    const priorNaked = !!prior && m.ctx.naked.some((nk) => nk.session === prior.start);
    if (prior?.va && cur) {
      const x0 = this.xLeft(cur.i0);
      line((prior.va.vah + 1) * row, x0, P.prior, [3, 3], "pVAH");
      line(prior.va.val * row, x0, P.prior, [3, 3], "pVAL");
      line((prior.va.poc + 0.5) * row, x0, P.prior, [8, 3], priorNaked ? "pPOC · naked" : "pPOC");
    }
    for (const nk of m.ctx.naked) {
      if (prior && nk.session === prior.start) continue; // already drawn as pPOC
      const sidx = m.sessions.findIndex((s) => s.start === nk.session);
      if (sidx < 0) continue;
      const s = m.sessions[sidx];
      // the prior session's POC is already drawn; label it naked if untouched
      const x0 = this.xLeft(s.i1) + this.barW;
      line((nk.row + 0.5) * row, x0, P.naked, [1, 3], `nPOC ${fmtDate(nk.session, this.meta.tz)}`);
    }
  }

  private drawBar(i: number, rowH: number, maxVisCell: number) {
    const m = this.model!;
    const b = m.bars[i];
    const ctx = this.ctx;
    const P = this.pal;
    const row = m.settings.rowUnits;
    const x = this.xLeft(i);
    const bw = this.barW;
    const up = b.c >= b.o;
    const src = barSource(b);
    const info = m.barInfo(b);

    if (bw < 7 || m.settings.view !== "footprint") {
      // pure candle mode (also used by the Profiles view)
      const cx = Math.round(x + bw / 2) + 0.5;
      const color = src === "est" ? (up ? alpha(P.buy, 0.55) : alpha(P.sell, 0.55)) : up ? P.buy : P.sell;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, this.yOf(b.h + this.meta.tick));
      ctx.lineTo(cx, this.yOf(b.l));
      ctx.stroke();
      const yo = this.yOf(b.o + this.meta.tick / 2);
      const yc = this.yOf(b.c + this.meta.tick / 2);
      ctx.fillStyle = color;
      ctx.fillRect(x + bw * 0.15, Math.min(yo, yc), Math.max(1, bw * 0.7), Math.max(1, Math.abs(yc - yo)));
      return;
    }

    const gap = bw >= 20 ? 2 : 1;
    const candleW = bw >= 26 ? Math.max(3, Math.min(8, Math.round(bw * 0.09))) : 0;
    const cx0 = x + gap + candleW + (candleW ? 2 : 0);
    const cw = bw - 2 * gap - candleW - (candleW ? 2 : 0);
    const textMode = cw >= 54 && rowH >= 11;
    const yTop = this.L.mainY0;
    const yBot = this.L.mainY1;

    // imbalance lookup
    const imbFlags = new Map<number, number>();
    for (const im of info.imb) imbFlags.set(im.row, (imbFlags.get(im.row) ?? 0) | (im.side === "buy" ? 1 : 2));

    const fontPx = Math.max(9, Math.min(12, Math.floor(rowH - 2)));
    if (textMode) ctx.font = `${fontPx}px ${MONO}`;
    const barMax = info.maxCell || 1;
    const visMax = maxVisCell || 1;
    const rowGap = rowH >= 4 ? 1 : 0;

    for (const [r, c] of b.cells) {
      const y0 = this.yOf((r + 1) * row);
      if (y0 > yBot || y0 + rowH < yTop) continue;
      const real = c.b + c.s;
      const tot = real + c.e;
      if (tot <= 0) continue;
      const h = Math.max(1, rowH - rowGap);
      if (textMode) {
        // volume histogram within the bar, coloured by cell delta (real) or hatched (estimated)
        const wv = Math.max(1, (cw * tot) / barMax);
        if (real > 0) {
          const d = c.b - c.s;
          const k = Math.min(1, Math.abs(d) / Math.max(real, 1e-12));
          ctx.fillStyle = alpha(d >= 0 ? P.buy : P.sell, 0.12 + 0.22 * k);
          ctx.fillRect(cx0, y0, (cw * real) / barMax, h);
        }
        if (c.e > 0) {
          const xe = cx0 + (cw * real) / barMax;
          const we = (cw * c.e) / barMax;
          ctx.fillStyle = alpha(P.est, 0.16);
          ctx.fillRect(xe, y0, we, h);
          if (this.hatch) {
            ctx.fillStyle = this.hatch;
            ctx.fillRect(xe, y0, we, h);
          }
        }
        void wv;
        const ty = y0 + h / 2 + 0.5;
        ctx.textBaseline = "middle";
        if (real > 0) {
          const f = imbFlags.get(r) ?? 0;
          const mid = cx0 + cw / 2;
          ctx.textAlign = "right";
          ctx.fillStyle = f & 2 ? P.sellText : alpha(P.text, 0.78);
          ctx.font = `${f & 2 ? "700 " : ""}${fontPx}px ${MONO}`;
          ctx.fillText(fmtVol(c.s), mid - 5, ty);
          ctx.textAlign = "left";
          ctx.fillStyle = f & 1 ? P.buyText : alpha(P.text, 0.78);
          ctx.font = `${f & 1 ? "700 " : ""}${fontPx}px ${MONO}`;
          ctx.fillText(fmtVol(c.b), mid + 5, ty);
          ctx.fillStyle = alpha(P.dim, 0.7);
          ctx.textAlign = "center";
          ctx.font = `${fontPx - 1}px ${MONO}`;
          ctx.fillText("×", mid, ty);
          ctx.font = `${fontPx}px ${MONO}`;
        } else {
          ctx.textAlign = "center";
          ctx.fillStyle = P.est;
          ctx.font = `italic ${fontPx}px ${MONO}`;
          ctx.fillText("~" + fmtVol(c.e), cx0 + cw / 2, ty);
          ctx.font = `${fontPx}px ${MONO}`;
        }
      } else {
        const k = Math.sqrt(tot / visMax);
        if (real > 0 && real >= c.e) {
          const d = c.b - c.s;
          ctx.fillStyle = alpha(d >= 0 ? P.buy : P.sell, 0.18 + 0.72 * k);
          ctx.fillRect(cx0, y0, cw, h);
        } else {
          ctx.fillStyle = alpha(P.est, 0.12 + 0.6 * k);
          ctx.fillRect(cx0, y0, cw, h);
          if (this.hatch && h >= 2) {
            ctx.fillStyle = this.hatch;
            ctx.fillRect(cx0, y0, cw, h);
          }
        }
        if (bw >= 14) {
          const f = imbFlags.get(r) ?? 0;
          if (f & 1) {
            ctx.fillStyle = P.buyText;
            ctx.fillRect(cx0 + cw - 2, y0, 2, h);
          }
          if (f & 2) {
            ctx.fillStyle = P.sellText;
            ctx.fillRect(cx0, y0, 2, h);
          }
        }
      }
    }

    // bar POC cell outline
    if (info.poc !== null && rowH >= 3 && cw >= 8) {
      const y0 = this.yOf((info.poc + 1) * row);
      ctx.strokeStyle = alpha(P.poc, 0.9);
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(cx0) + 0.5, Math.round(y0) + 0.5, Math.max(1, Math.round(cw) - 1), Math.max(1, Math.round(rowH - rowGap) - 1));
    }
    // stacked imbalance zones (3+ rows)
    for (const st of info.stacked) {
      const y0 = this.yOf((st.to + 1) * row);
      const y1 = this.yOf(st.from * row);
      ctx.fillStyle = st.side === "buy" ? P.buyText : P.sellText;
      const xx = st.side === "buy" ? x + bw - gap - 1 : cx0 - 2;
      ctx.fillRect(xx, y0, 2, y1 - y0);
    }

    // OHLC: body outline across the cell column + candle strip
    const tick = this.meta.tick;
    const yo = this.yOf(b.o + tick / 2);
    const yc = this.yOf(b.c + tick / 2);
    const yh = this.yOf(b.h + tick);
    const yl = this.yOf(b.l);
    const col = up ? P.buy : P.sell;
    ctx.lineWidth = 1;
    ctx.strokeStyle = alpha(col, src === "est" ? 0.45 : 0.75);
    if (src === "est") ctx.setLineDash([3, 2]);
    // body outline over the cells, from the open row to the close row
    const ro = Math.floor(b.o / row);
    const rc = Math.floor(b.c / row);
    const yb0 = this.yOf((Math.max(ro, rc) + 1) * row);
    const yb1 = this.yOf(Math.min(ro, rc) * row);
    ctx.strokeRect(Math.round(cx0) - 0.5, Math.round(yb0) + 0.5, Math.round(cw) + 1, Math.max(1, Math.round(yb1 - yb0) - 1));
    ctx.setLineDash([]);
    if (candleW) {
      const sx = x + gap;
      const mx = Math.round(sx + candleW / 2) + 0.5;
      ctx.strokeStyle = col;
      ctx.beginPath();
      ctx.moveTo(mx, yh);
      ctx.lineTo(mx, yl);
      ctx.stroke();
      const bt = Math.min(yo, yc);
      const bh = Math.max(1, Math.abs(yc - yo));
      if (src === "est") {
        ctx.fillStyle = P.bg;
        ctx.fillRect(sx, bt, candleW, bh);
        ctx.strokeRect(sx + 0.5, bt + 0.5, candleW - 1, Math.max(1, bh - 1));
      } else {
        ctx.fillStyle = col;
        ctx.fillRect(sx, bt, candleW, bh);
      }
    } else if (cw < 10) {
      // narrow: wick through the column
      const mx = Math.round(x + bw / 2) + 0.5;
      ctx.strokeStyle = alpha(col, 0.9);
      ctx.beginPath();
      ctx.moveTo(mx, yh);
      ctx.lineTo(mx, yl);
      ctx.stroke();
    }
  }

  /** x-span of a session in the plot (the current session extends to the plot edge). */
  private sessionSpan(k: number): [number, number] {
    const m = this.model!;
    const s = m.sessions[k];
    const x0 = this.xLeft(s.i0);
    const x1 = k === m.sessions.length - 1 ? Math.max(this.xLeft(s.i1) + this.barW, this.L.plotX1 - RIGHT_PAD) : this.xLeft(s.i1) + this.barW;
    return [x0, x1];
  }

  /** Profiles view: each session's volume profile drawn inside its own time span. */
  private drawSessionHistograms(i0: number, i1: number) {
    const m = this.model!;
    const ctx = this.ctx;
    const P = this.pal;
    const row = m.settings.rowUnits;
    const rowH = row / this.upp;
    const gap = rowH >= 4 ? 1 : 0;
    const h = Math.max(1, rowH - gap);
    const rTop = Math.ceil(this.uOf(this.L.mainY0) / row) + 1;
    const rBot = Math.floor(this.uOf(this.L.mainY1) / row) - 1;
    for (let k = 0; k < m.sessions.length; k++) {
      const s = m.sessions[k];
      if (s.i1 < i0 || s.i0 > i1) continue;
      const p = s.profile;
      const [x0, x1] = this.sessionSpan(k);
      const maxW = (x1 - x0) * 0.82;
      if (maxW < 6) continue;
      let maxV = 0;
      for (let i = 0; i < p.vol.length; i++) if (p.vol[i] > maxV) maxV = p.vol[i];
      if (maxV <= 0) continue;
      const va = s.va;
      for (let r = Math.max(p.lo, rBot); r <= Math.min(p.hi, rTop); r++) {
        const i = r - p.lo;
        const v = p.vol[i];
        if (v <= 0) continue;
        const y = this.yOf((r + 1) * row);
        const inVa = !!va && r >= va.val && r <= va.vah;
        const isPoc = !!va && r === va.poc;
        const base = isPoc ? P.poc : inVa ? P.profileVa : P.profile;
        const wReal = (maxW * (p.buy[i] + p.sell[i])) / maxV;
        const wEst = (maxW * p.est[i]) / maxV;
        if (wReal > 0) {
          ctx.fillStyle = alpha(base, isPoc ? 0.75 : 0.55);
          ctx.fillRect(x0 + 1, y, wReal, h);
        }
        if (wEst > 0) {
          ctx.fillStyle = alpha(base, isPoc ? 0.6 : 0.36);
          ctx.fillRect(x0 + 1 + wReal, y, wEst, h);
          if (this.hatchProfile && h >= 3 && !isPoc) {
            ctx.fillStyle = this.hatchProfile;
            ctx.globalAlpha = 0.35;
            ctx.fillRect(x0 + 1 + wReal, y, wEst, h);
            ctx.globalAlpha = 1;
          }
        }
      }
      // per-session level labels at the right end of the session
      if (va && x1 - x0 > 70) {
        ctx.font = `10px ${MONO}`;
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        const dp = this.priceDp(row);
        const lab = (u: number, color: string, txt: string) => {
          const y = this.yOf(u);
          if (y < this.L.mainY0 + 6 || y > this.L.mainY1 - 6) return;
          ctx.fillStyle = color;
          ctx.fillText(`${txt} ${formatUnits(u, dp)}`, x1 - 4, y - 6);
        };
        if (k !== m.sessions.length - 1) {
          lab((va.vah + 1) * row, P.va, "VAH");
          lab((va.poc + 0.5) * row, P.poc, "POC");
          lab(va.val * row, P.va, "VAL");
        }
      }
    }
  }

  /** TPO view: stacked period letters per session (blocks when zoomed out). */
  private drawTpo(i0: number, i1: number, rowH: number) {
    const m = this.model!;
    const ctx = this.ctx;
    const P = this.pal;
    const row = m.settings.rowUnits;
    const dark = document.documentElement.dataset.theme !== "light";
    const color = (k: number, n: number) => {
      const hue = 205 - (Math.min(k, 47) / Math.max(1, Math.min(n, 48) - 1)) * 205;
      return `hsl(${hue.toFixed(0)} ${dark ? "62% 62%" : "70% 38%"})`;
    };
    const rTop = Math.ceil(this.uOf(this.L.mainY0) / row) + 1;
    const rBot = Math.floor(this.uOf(this.L.mainY1) / row) - 1;
    for (let k = 0; k < m.sessions.length; k++) {
      const s = m.sessions[k];
      const t = m.tpo[k];
      if (!t || s.i1 < i0 || s.i0 > i1) continue;
      const [sx0, sx1] = this.sessionSpan(k);
      const x0 = sx0 + 8;
      let maxC = 0;
      for (const c of t.counts) if (c > maxC) maxC = c;
      const cellW = Math.max(1, Math.min(rowH >= 9 ? Math.max(8, rowH * 0.85) : 6, (sx1 - x0 - 4) / Math.max(1, maxC)));
      const h = Math.max(1, rowH - (rowH >= 4 ? 1 : 0));
      const letters = cellW >= 7 && rowH >= 9;
      const fontPx = Math.max(8, Math.min(13, Math.floor(Math.min(rowH, cellW * 1.25) - 1)));
      if (letters) {
        ctx.font = `600 ${fontPx}px ${MONO}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
      }
      const n = t.periods;
      for (let r = Math.max(t.lo, rBot); r <= Math.min(t.hi, rTop); r++) {
        const ps = t.rows[r - t.lo];
        if (!ps.length) continue;
        const y = this.yOf((r + 1) * row);
        if (t.poc === r) {
          ctx.fillStyle = alpha(P.poc, 0.22);
          ctx.fillRect(x0 - 1, y, ps.length * cellW + 2, h);
        }
        for (let j = 0; j < ps.length; j++) {
          const cx = x0 + j * cellW;
          if (letters) {
            ctx.fillStyle = color(ps[j], n);
            ctx.fillText(tpoLetter(ps[j]), cx + cellW / 2, y + h / 2 + 0.5);
          } else {
            ctx.fillStyle = color(ps[j], n);
            ctx.fillRect(cx, y, Math.max(1, cellW - (cellW >= 3 ? 1 : 0)), h);
          }
        }
      }
      // initial balance bracket
      if (t.ib) {
        const yA = this.yOf((t.ib.hiRow + 1) * row);
        const yB = this.yOf(t.ib.loRow * row);
        ctx.fillStyle = alpha(P.va, 0.9);
        ctx.fillRect(sx0 + 3, yA, 2, yB - yA);
      }
      // single prints marker
      for (const sp of t.singlePrints) {
        if (sp.to - sp.from < 1) continue; // runs of 2+ rows only
        const yA = this.yOf((sp.to + 1) * row);
        const yB = this.yOf(sp.from * row);
        ctx.fillStyle = alpha(P.ctxMark, 0.85);
        ctx.fillRect(x0 - 4, yA, 2, yB - yA);
      }
      // Poor extremes. Plain text rather than pills, to stay light against the
      // letter grid, but reserved through the same stacker: both labels hang
      // off the same session's left edge, so a session whose range is tight on
      // screen puts "poor high" and "poor low" on the same pixels. (Adjacent
      // sessions cannot collide: barW floors at 2, so a session is always
      // wider than the text.)
      if (k !== m.sessions.length - 1 && (t.poorHigh || t.poorLow)) {
        ctx.font = `600 9px ${SANS}`;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillStyle = P.ctxMark;
        const mark = (text: string, py: number, dir: 1 | -1) => {
          const want = py + dir * (TPO_LAB_H / 2 + 2);
          const cy = this.reserveLabel(x0, x0 + ctx.measureText(text).width, want, dir, TPO_LAB_H);
          if (cy === null) return;
          if (Math.abs(cy - want) > 1) this.leader(x0 + 2, py, cy, TPO_LAB_H, P.ctxMark);
          ctx.fillStyle = P.ctxMark;
          ctx.fillText(text, x0, cy);
        };
        if (t.poorHigh) mark("poor high", this.yOf((t.hi + 1) * row), -1);
        if (t.poorLow) mark("poor low", this.yOf(t.lo * row), 1);
      }
    }
  }

  /** Composite VAH / VAL / POC across the whole plot when the composite profile is shown. */
  private drawCompositeLevels() {
    const m = this.model!;
    const c = m.composite;
    if (m.settings.rightProfile !== "composite" || !c?.va) return;
    const ctx = this.ctx;
    const P = this.pal;
    const L = this.L;
    const row = m.settings.rowUnits;
    ctx.font = `10px ${MONO}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    const line = (u: number, color: string, dash: number[], label: string) => {
      const y = Math.round(this.yOf(u)) + 0.5;
      if (y < L.mainY0 || y > L.mainY1) return;
      ctx.strokeStyle = alpha(color, 0.75);
      ctx.setLineDash(dash);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(L.plotX0, y);
      ctx.lineTo(L.plotX1, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
      ctx.fillStyle = color;
      ctx.fillText(label, L.plotX0 + 4, y - 2);
    };
    line((c.va.vah + 1) * row, P.va, [10, 4], `cVAH ${c.days}d`);
    line(c.va.val * row, P.va, [10, 4], `cVAL ${c.days}d`);
    line((c.va.poc + 0.5) * row, P.poc, [10, 4], `cPOC ${c.days}d`);
  }

  private drawDevelopingPoc(i0: number, i1: number) {
    const m = this.model!;
    const ctx = this.ctx;
    const row = m.settings.rowUnits;
    ctx.strokeStyle = alpha(this.pal.poc, 0.95);
    ctx.lineWidth = 1.5;
    for (const s of m.sessions) {
      if (s.i1 < i0 || s.i0 > i1) continue;
      ctx.beginPath();
      let started = false;
      let prevY = 0;
      for (let i = Math.max(s.i0, i0 - 1); i <= Math.min(s.i1, i1 + 1); i++) {
        const p = s.dpoc[i - s.i0];
        if (p === null) continue;
        const y = Math.round(this.yOf((p + 0.5) * row)) + 0.5;
        const xa = this.xLeft(i);
        const xb = xa + this.barW;
        if (!started) {
          ctx.moveTo(xa, y);
          started = true;
        } else if (y !== prevY) ctx.lineTo(xa, y);
        ctx.lineTo(xb, y);
        prevY = y;
      }
      ctx.stroke();
    }
    ctx.lineWidth = 1;
  }

  private drawContextMarkers() {
    const m = this.model!;
    const ctx = this.ctx;
    const P = this.pal;
    const L = this.L;
    const row = m.settings.rowUnits;
    const cur = m.sessions[m.sessions.length - 1];
    if (!cur) return;
    const xs = this.xLeft(cur.i0);
    // single prints: faint bands from session start to the right edge
    for (const sp of m.ctx.singlePrints) {
      const y0 = this.yOf((sp.to + 1) * row);
      const y1 = this.yOf(sp.from * row);
      ctx.fillStyle = alpha(P.ctxMark, 0.06);
      ctx.fillRect(xs, y0, L.plotX1 - xs, y1 - y0);
      ctx.strokeStyle = alpha(P.ctxMark, 0.35);
      ctx.setLineDash([2, 3]);
      ctx.strokeRect(xs + 0.5, Math.round(y0) + 0.5, L.plotX1 - xs - 1, Math.max(1, Math.round(y1 - y0) - 1));
      ctx.setLineDash([]);
    }
    ctx.font = `10px ${SANS}`;
    ctx.textBaseline = "middle";
    // poor highs / lows
    for (const pe of m.ctx.poor) {
      const isHigh = pe.kind === "poor-high";
      const u = isHigh ? (pe.row + 1) * row : pe.row * row;
      const y = Math.round(this.yOf(u)) + 0.5;
      ctx.strokeStyle = P.ctxMark;
      ctx.setLineDash([4, 2]);
      ctx.beginPath();
      ctx.moveTo(xs, y);
      ctx.lineTo(L.plotX1, y);
      ctx.stroke();
      ctx.setLineDash([]);
      this.pill(L.plotX1 - 70, y + (isHigh ? -9 : 9), isHigh ? "poor high" : "poor low", P.ctxMark, isHigh ? -1 : 1);
    }
    // failed auctions vs prior session references
    for (const fa of m.ctx.failed) {
      if (fa.backIdx < 0) continue;
      const isUp = fa.ref.dir === 1;
      const xa = this.xLeft(fa.breakIdx);
      const xb = this.xLeft(fa.backIdx) + this.barW;
      const yRef = Math.round(this.yOf(fa.ref.price)) + 0.5;
      const yEx = this.yOf(isUp ? fa.extreme + this.meta.tick : fa.extreme);
      ctx.strokeStyle = alpha(P.ctxMark, 0.9);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(xa, yRef);
      ctx.lineTo(xa, yEx);
      ctx.lineTo(xb, yEx);
      ctx.lineTo(xb, yRef);
      ctx.stroke();
      // arrow pointing back inside
      const ax = xb;
      const ay = yEx + (isUp ? -8 : 8);
      ctx.fillStyle = P.ctxMark;
      ctx.beginPath();
      if (isUp) {
        ctx.moveTo(ax - 5, ay - 6);
        ctx.lineTo(ax + 5, ay - 6);
        ctx.lineTo(ax, ay);
      } else {
        ctx.moveTo(ax - 5, ay + 6);
        ctx.lineTo(ax + 5, ay + 6);
        ctx.lineTo(ax, ay);
      }
      ctx.fill();
      const q = fa.deltaQuality === "real" ? "" : fa.deltaQuality === "estimated" ? " est" : " mixed";
      const known = fa.deltaQuality === "real" || this.meta.estDelta;
      const lab = `failed ${isUp ? "above" : "below"} ${fa.ref.label.replace("prior ", "p")} · ${known ? `Δ${fmtSigned(fa.excursionDelta)}${q} ${fa.supported ? "with" : "against"}` : "Δ unknown"}`;
      this.pill(ax, ay + (isUp ? -16 : 16), lab, P.ctxMark, isUp ? -1 : 1);
    }
  }

  /**
   * The account overlay. Drawn solid because every one of these is a real,
   * measured number from the account — unlike the hatched estimated volume —
   * except the breach floors, which are computed and so are dashed and
   * labelled as floors. Labels go through the same stacker as the context
   * pills, so a stop sitting on a breach line stays readable.
   */
  private drawAccountLines() {
    if (!this.accountLines.length) return;
    const ctx = this.ctx;
    const L = this.L;
    const P = this.pal;
    const colorOf = (t: AccountLine["tone"]) => (t === "bad" ? P.sell : t === "good" ? P.buy : t === "warn" ? P.poc : P.text);
    for (const l of this.accountLines) {
      const raw = this.yOf(l.price);
      const col = colorOf(l.tone);
      // A breach floor is often far outside a tight view — on a 2-point window
      // the floor can be 4 points away. Pin it to the edge with an arrow rather
      // than dropping it, so "no line" always means "no line", not "off-screen".
      if (raw < L.mainY0 || raw > L.mainY1) {
        const above = raw < L.mainY0;
        const y = above ? L.mainY0 + 8 : L.mainY1 - 8;
        ctx.fillStyle = alpha(col, 0.9);
        ctx.beginPath();
        const ax = L.plotX0 + 14;
        if (above) {
          ctx.moveTo(ax, y - 7);
          ctx.lineTo(ax - 5, y);
          ctx.lineTo(ax + 5, y);
        } else {
          ctx.moveTo(ax, y + 7);
          ctx.lineTo(ax - 5, y);
          ctx.lineTo(ax + 5, y);
        }
        ctx.fill();
        this.pill(L.plotX0 + 86, y, `${l.label} ${above ? "↑" : "↓"}`, col, above ? 1 : -1);
        continue;
      }
      const y = Math.round(raw) + 0.5;
      const floor = l.kind === "daily-breach" || l.kind === "drawdown-breach";
      ctx.strokeStyle = alpha(col, floor ? 0.85 : 0.95);
      ctx.lineWidth = floor ? 1.5 : 1;
      if (floor) ctx.setLineDash([7, 4]);
      ctx.beginPath();
      ctx.moveTo(L.plotX0, y);
      ctx.lineTo(L.plotX1, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
      this.pill(L.plotX0 + 68, y - 9, l.label, col, -1);
    }
  }

  private drawDivergencesPrice(i0: number, i1: number) {
    const m = this.model!;
    const ctx = this.ctx;
    for (const d of m.ctx.divergences) {
      if (d.idx < i0 || d.refIdx > i1) continue;
      const a = m.bars[d.refIdx];
      const b = m.bars[d.idx];
      const bear = d.kind === "bearish";
      const ya = this.yOf(bear ? a.h + this.meta.tick : a.l) + (bear ? -4 : 4);
      const yb = this.yOf(bear ? b.h + this.meta.tick : b.l) + (bear ? -4 : 4);
      ctx.strokeStyle = alpha(bear ? this.pal.sell : this.pal.buy, 0.9);
      ctx.lineWidth = 1.25;
      if (d.quality === "est") ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(this.xLeft(d.refIdx) + this.barW / 2, ya);
      ctx.lineTo(this.xLeft(d.idx) + this.barW / 2, yb);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
    }
  }

  /**
   * Reserve an `h`-tall label box spanning x0..x1 and centred on `y`, stacked
   * clear of the labels already placed this frame by sliding along `dir` (-1
   * up, 1 down) away from the anchor. Returns the centre y to draw at, or null
   * when the stack runs out of room inside the main plot — the context panel
   * lists every marker, so the chart drops a label rather than printing a pile
   * of unreadable text.
   */
  private reserveLabel(x0: number, x1: number, y: number, dir: 1 | -1, h: number): number | null {
    const L = this.L;
    const spot = placeLabel(
      { x0, x1, y0: y - h / 2, y1: y + h / 2 },
      this.taken,
      dir,
      { gap: 2, minY: L.mainY0 + 1, maxY: L.mainY1 - 1 },
    );
    if (!spot.fits) return null;
    this.taken.push({ x0, x1, y0: spot.y0, y1: spot.y1 });
    return spot.y0 + h / 2;
  }

  /**
   * Faint dotted line from a label that had to move back to the price it marks,
   * so a shifted label is never read as marking the level it now sits on.
   * Callers draw it only when the label actually shifted.
   */
  private leader(x: number, anchorY: number, labelY: number, h: number, color: string) {
    const ctx = this.ctx;
    const near = labelY + (labelY > anchorY ? -h / 2 : h / 2);
    ctx.strokeStyle = alpha(color, 0.45);
    ctx.setLineDash([1, 2]);
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, anchorY);
    ctx.lineTo(Math.round(x) + 0.5, near);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /** Boxed context label centred on (x, y). False when it could not be placed. */
  private pill(x: number, y: number, text: string, color: string, dir: 1 | -1 = 1): boolean {
    const ctx = this.ctx;
    const L = this.L;
    ctx.font = `10px ${SANS}`;
    const w = ctx.measureText(text).width + 8;
    const px = Math.max(L.plotX0 + 2, Math.min(L.plotX1 - w - 2, x - w / 2));
    const cy = this.reserveLabel(px, px + w, y, dir, 14);
    if (cy === null) return false;
    if (Math.abs(cy - y) > 1) this.leader(x, y, cy, 14, color);
    ctx.fillStyle = alpha(this.pal.panel, 0.92);
    ctx.fillRect(px, cy - 7, w, 14);
    ctx.strokeStyle = alpha(color, 0.8);
    ctx.strokeRect(px + 0.5, cy - 6.5, w - 1, 13);
    ctx.fillStyle = color;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(text, px + 4, cy + 0.5);
    return true;
  }

  private drawLastPrice() {
    const lp = this.meta.lastPrice;
    if (lp == null) return;
    const ctx = this.ctx;
    const y = Math.round(this.yOf(lp + this.meta.tick / 2)) + 0.5;
    ctx.strokeStyle = alpha(this.pal.text, 0.5);
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(this.L.plotX0, y);
    ctx.lineTo(this.L.plotX1, y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private drawSourceStrip(i0: number, i1: number) {
    const m = this.model!;
    const ctx = this.ctx;
    const P = this.pal;
    const L = this.L;
    ctx.fillStyle = P.panel;
    ctx.fillRect(L.plotX0, 0, L.plotX1 - L.plotX0, L.mainY0);
    const y = L.mainY0 - 5;
    for (let i = i0; i <= i1; i++) {
      const b = m.bars[i];
      const x = this.xLeft(i) + 1;
      const w = Math.max(1, this.barW - 2);
      const src = barSource(b);
      if (src === "real") {
        ctx.fillStyle = P.cvd;
        ctx.fillRect(x, y, w, 3);
      } else if (src === "mixed") {
        const f = (b.buy + b.sell) / Math.max(b.vol, 1e-12);
        ctx.fillStyle = alpha(P.est, 0.5);
        ctx.fillRect(x, y, w, 3);
        ctx.fillStyle = P.cvd;
        ctx.fillRect(x + w * (1 - f), y, w * f, 3);
      } else {
        ctx.fillStyle = alpha(P.est, 0.45);
        ctx.fillRect(x, y, w, 3);
      }
    }
    // marker where live recording starts
    const rs = this.meta.realSince;
    if (rs != null) {
      let idx = -1;
      for (let i = i0; i <= i1; i++) if (m.bars[i].t + m.bars[i].dur > rs) {
        idx = i;
        break;
      }
      if (idx >= 0 && m.bars[idx].t <= rs + m.bars[idx].dur) {
        const x = Math.round(this.xLeft(idx) + ((rs - m.bars[idx].t) / m.bars[idx].dur) * this.barW) + 0.5;
        if (x > L.plotX0 && x < L.plotX1) {
          ctx.strokeStyle = alpha(P.cvd, 0.7);
          ctx.setLineDash([2, 3]);
          ctx.beginPath();
          ctx.moveTo(x, L.mainY0);
          ctx.lineTo(x, L.cvdY1);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.font = `600 10px ${SANS}`;
          ctx.fillStyle = P.cvd;
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.fillText("● recording live trades", x + 4, 7);
          ctx.textAlign = "right";
          ctx.fillStyle = P.est;
          if (x - 4 > 160) ctx.fillText("estimated from 1m candles", x - 4, 7);
        }
      }
    }
  }

  private drawSessionSeparators(i0: number, i1: number) {
    const m = this.model!;
    const ctx = this.ctx;
    const P = this.pal;
    const L = this.L;
    for (const s of m.sessions) {
      if (s.i0 <= i0 || s.i0 > i1) continue;
      const x = Math.round(this.xLeft(s.i0)) + 0.5;
      ctx.strokeStyle = P.session;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, L.mainY0);
      ctx.lineTo(x, L.cvdY1);
      ctx.stroke();
      ctx.fillStyle = P.dim;
      ctx.font = `600 10px ${SANS}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillText(`Session ${fmtDateTime(s.start, this.meta.tz)}`, x + 4, L.mainY1 - 3);
    }
  }

  private drawDeltaStrip(i0: number, i1: number) {
    const m = this.model!;
    const ctx = this.ctx;
    const P = this.pal;
    const L = this.L;
    ctx.fillStyle = P.panel;
    ctx.fillRect(L.plotX0, L.deltaY0, L.axisX1, L.deltaY1 - L.deltaY0);
    const est = this.meta.estDelta;
    let maxD = 0;
    let maxV = 0;
    for (let i = i0; i <= i1; i++) {
      const b = m.bars[i];
      maxD = Math.max(maxD, Math.abs(barDelta(b, true)));
      maxV = Math.max(maxV, b.vol);
    }
    const textMode = this.barW >= 34;
    const yMid = (L.deltaY0 + L.deltaY1) / 2;
    ctx.save();
    ctx.beginPath();
    ctx.rect(L.plotX0, L.deltaY0, L.plotX1 - L.plotX0, L.deltaY1 - L.deltaY0);
    ctx.clip();
    for (let i = i0; i <= i1; i++) {
      const b = m.bars[i];
      const x = this.xLeft(i);
      const w = this.barW;
      const realD = b.realDelta;
      const hasReal = b.buy + b.sell > 0;
      const estOnly = !hasReal;
      const d = barDelta(b, est);
      const k = maxD > 0 ? Math.min(1, Math.abs(d) / maxD) : 0;
      if (hasReal || est) {
        ctx.fillStyle = alpha(d >= 0 ? P.buy : P.sell, (estOnly ? 0.06 : 0.1) + (estOnly ? 0.18 : 0.45) * k);
        ctx.fillRect(x + 1, L.deltaY0 + 1, w - 2, L.deltaY1 - L.deltaY0 - 2);
      }
      if (textMode) {
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = `${estOnly ? "italic " : ""}10px ${MONO}`;
        if (estOnly) {
          ctx.fillStyle = P.est;
          ctx.fillText(est ? "~" + fmtSigned(b.estDelta) : "Δ n/a", x + w / 2, yMid - 7);
        } else {
          ctx.fillStyle = realD >= 0 ? P.buyText : P.sellText;
          const partial = b.estVol > 0;
          ctx.fillText(fmtSigned(est ? d : realD) + (partial ? "*" : ""), x + w / 2, yMid - 7);
        }
        ctx.font = `10px ${MONO}`;
        ctx.fillStyle = estOnly ? alpha(P.est, 0.9) : P.dim;
        ctx.fillText(fmtVol(b.vol), x + w / 2, yMid + 8);
      } else if (maxV > 0) {
        // compact: volume bars
        const vh = ((L.deltaY1 - L.deltaY0 - 4) * b.vol) / maxV;
        ctx.fillStyle = estOnly ? alpha(P.est, 0.5) : alpha(b.c >= b.o ? P.buy : P.sell, 0.7);
        ctx.fillRect(x + Math.max(0, w * 0.15), L.deltaY1 - 2 - vh, Math.max(1, w * 0.7), vh);
      }
    }
    ctx.restore();
    ctx.fillStyle = P.dim;
    ctx.font = `600 10px ${SANS}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const ax = L.axisX0 + 6;
    if (textMode) {
      ctx.fillText(est ? "Δ incl. est" : "Δ real", ax, yMid - 7);
      ctx.fillText("Volume", ax, yMid + 8);
    } else ctx.fillText("Volume", ax, yMid);
  }

  private drawCvd(i0: number, i1: number) {
    const m = this.model!;
    const ctx = this.ctx;
    const P = this.pal;
    const L = this.L;
    const y0 = L.cvdY0 + 14;
    const y1 = L.cvdY1 - 6;
    let lo = 0;
    let hi = 0;
    for (let i = i0; i <= i1; i++) {
      const v = m.cvd[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (hi === lo) {
      hi += 1;
      lo -= 1;
    }
    const yv = (v: number) => y1 - ((v - lo) / (hi - lo)) * (y1 - y0);
    ctx.save();
    ctx.beginPath();
    ctx.rect(L.plotX0, L.cvdY0, L.plotX1 - L.plotX0, L.cvdY1 - L.cvdY0);
    ctx.clip();
    // zero line
    ctx.strokeStyle = P.gridStrong;
    ctx.beginPath();
    ctx.moveTo(L.plotX0, Math.round(yv(0)) + 0.5);
    ctx.lineTo(L.plotX1, Math.round(yv(0)) + 0.5);
    ctx.stroke();
    // per session polylines; estimated stretches dashed
    for (const s of m.sessions) {
      if (s.i1 < i0 || s.i0 > i1) continue;
      const a = Math.max(s.i0, i0 - 1);
      const b = Math.min(s.i1, i1 + 1);
      // area fill
      ctx.beginPath();
      ctx.moveTo(this.xLeft(a), yv(0));
      for (let i = a; i <= b; i++) ctx.lineTo(this.xLeft(i) + this.barW / 2, yv(m.cvd[i]));
      ctx.lineTo(this.xLeft(b) + this.barW, yv(m.cvd[b]));
      ctx.lineTo(this.xLeft(b) + this.barW, yv(0));
      ctx.closePath();
      ctx.fillStyle = alpha(P.cvd, 0.08);
      ctx.fill();
      for (let i = a; i <= b; i++) {
        const prev = i === s.i0 ? 0 : m.cvd[i - 1];
        const xa = i === s.i0 ? this.xLeft(i) : this.xLeft(i - 1) + this.barW / 2;
        const xb = this.xLeft(i) + this.barW / 2;
        const real = m.realBar[i] || m.bars[i].buy + m.bars[i].sell > 0;
        ctx.strokeStyle = real ? P.cvd : alpha(P.est, 0.8);
        ctx.lineWidth = real ? 1.5 : 1;
        ctx.setLineDash(real ? [] : [3, 3]);
        ctx.beginPath();
        ctx.moveTo(xa, yv(prev));
        ctx.lineTo(xb, yv(m.cvd[i]));
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
    }
    // divergence segments on CVD
    if (this.meta.showDivergence) {
      for (const d of m.ctx.divergences) {
        if (d.idx < i0 || d.refIdx > i1) continue;
        ctx.strokeStyle = d.kind === "bearish" ? P.sell : P.buy;
        if (d.quality === "est") ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.moveTo(this.xLeft(d.refIdx) + this.barW / 2, yv(m.cvd[d.refIdx]));
        ctx.lineTo(this.xLeft(d.idx) + this.barW / 2, yv(m.cvd[d.idx]));
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineWidth = 1;
        ctx.fillStyle = d.kind === "bearish" ? P.sell : P.buy;
        ctx.beginPath();
        ctx.arc(this.xLeft(d.idx) + this.barW / 2, yv(m.cvd[d.idx]), 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
    ctx.fillStyle = P.dim;
    ctx.font = `600 10px ${SANS}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(
      this.meta.estDelta ? "CVD, real trades + close-location estimate (dashed), resets each session" : "CVD from real aggressor delta only, resets each session",
      L.plotX0 + 6,
      L.cvdY0 + 3,
    );
    // axis labels
    ctx.font = `10px ${MONO}`;
    ctx.textBaseline = "middle";
    ctx.fillStyle = P.dim;
    ctx.fillText(fmtSigned(hi), L.axisX0 + 6, y0);
    ctx.fillText(fmtSigned(lo), L.axisX0 + 6, y1);
    ctx.fillText("CVD", L.axisX0 + 6, (y0 + y1) / 2);
  }

  /** The session shown in the profile panel: the latest session, or the one at the right edge when scrolled back. */
  private profileSession(): SessionStats | null {
    const m = this.model!;
    if (!m.sessions.length) return null;
    const iR = Math.min(this.n - 1, Math.max(0, this.idxAt(this.L.plotX1 - RIGHT_PAD - 1)));
    const k = m.sessionOfBar[iR];
    return m.sessions[k ?? m.sessions.length - 1];
  }

  private drawProfile() {
    const m = this.model!;
    const ctx = this.ctx;
    const P = this.pal;
    const L = this.L;
    const sess = this.profileSession();
    ctx.fillStyle = P.panel;
    ctx.fillRect(L.profX0, 0, L.profX1 - L.profX0, L.timeY0);
    if (!sess) return;
    const comp = m.settings.rightProfile === "composite" ? m.composite : null;
    const s = comp
      ? { profile: comp.profile, va: comp.va, realShare: comp.realShare, volume: comp.profile.total, start: comp.start }
      : sess;
    const row = m.settings.rowUnits;
    const p = s.profile;
    const pw = L.profX1 - L.profX0 - 10;
    const x0 = L.profX0 + 4;
    let maxV = 0;
    for (let i = 0; i < p.vol.length; i++) if (p.vol[i] > maxV) maxV = p.vol[i];
    const rowH = row / this.upp;
    const gap = rowH >= 4 ? 1 : 0;
    ctx.save();
    ctx.beginPath();
    ctx.rect(L.profX0, L.mainY0, L.profX1 - L.profX0, L.mainY1 - L.mainY0);
    ctx.clip();
    const va = s.va;
    const rTop = Math.ceil(this.uOf(L.mainY0) / row);
    const rBot = Math.floor(this.uOf(L.mainY1) / row);
    for (let r = Math.max(p.lo, rBot - 1); r <= Math.min(p.hi, rTop + 1); r++) {
      const i = r - p.lo;
      const v = p.vol[i];
      if (v <= 0) continue;
      const y = this.yOf((r + 1) * row);
      const h = Math.max(1, rowH - gap);
      const inVa = !!va && r >= va.val && r <= va.vah;
      const real = p.buy[i] + p.sell[i];
      const wReal = (pw * real) / maxV;
      const wEst = (pw * p.est[i]) / maxV;
      const base = va && r === va.poc ? P.poc : inVa ? P.profileVa : P.profile;
      if (wReal > 0) {
        ctx.fillStyle = base;
        ctx.fillRect(x0, y, wReal, h);
      }
      if (wEst > 0) {
        ctx.fillStyle = alpha(base, 0.35);
        ctx.fillRect(x0 + wReal, y, wEst, h);
        if (this.hatchProfile && h >= 2) {
          ctx.fillStyle = this.hatchProfile;
          ctx.fillRect(x0 + wReal, y, wEst, h);
        }
      }
    }
    // LVN / single-print brackets
    if (this.meta.showMarkers && !comp && sess === m.sessions[m.sessions.length - 1]) {
      const marks: Array<[number, number, string]> = [
        ...m.ctx.lvn.map((r) => [r.from, r.to, "LVN"] as [number, number, string]),
        ...m.ctx.singlePrints.map((r) => [r.from, r.to, "SP"] as [number, number, string]),
      ];
      ctx.font = `600 8px ${SANS}`;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      for (const [a, b, lab] of marks) {
        const ya = this.yOf((b + 1) * row);
        const yb = this.yOf(a * row);
        const xr = L.profX1 - 3;
        ctx.strokeStyle = P.ctxMark;
        ctx.beginPath();
        ctx.moveTo(xr - 4, ya + 0.5);
        ctx.lineTo(xr, ya + 0.5);
        ctx.lineTo(xr, yb - 0.5);
        ctx.lineTo(xr - 4, yb - 0.5);
        ctx.stroke();
        if (yb - ya >= 8 || lab === "SP") {
          ctx.fillStyle = P.ctxMark;
          ctx.fillText(lab, xr - 6, (ya + yb) / 2);
        }
      }
    }
    // VA lines
    if (va) {
      ctx.strokeStyle = P.va;
      ctx.setLineDash([3, 2]);
      ctx.beginPath();
      const yH = Math.round(this.yOf((va.vah + 1) * row)) + 0.5;
      const yL = Math.round(this.yOf(va.val * row)) + 0.5;
      ctx.moveTo(L.profX0, yH);
      ctx.lineTo(L.profX1, yH);
      ctx.moveTo(L.profX0, yL);
      ctx.lineTo(L.profX1, yL);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
    // header
    ctx.fillStyle = P.dim;
    ctx.font = `600 10px ${SANS}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const realPct = s.realShare * 100;
    ctx.fillText(comp ? `Composite ${comp.days}d from ${fmtDate(comp.start, this.meta.tz)}` : `Profile ${fmtDate(s.start, this.meta.tz)}`, L.profX0 + 4, 8);
    // footer in delta strip area: data quality
    ctx.font = `9px ${SANS}`;
    ctx.fillStyle = P.dim;
    const fy = L.deltaY0 + 9;
    ctx.fillText(`vol ${fmtVol(s.volume)}`, L.profX0 + 4, fy);
    ctx.fillStyle = P.cvd;
    ctx.fillText(`real ${realPct < 0.1 && realPct > 0 ? "<0.1" : realPct.toFixed(realPct < 10 ? 1 : 0)}%`, L.profX0 + 4, fy + 12);
    ctx.fillStyle = P.est;
    const ex = L.profX0 + 4 + ctx.measureText(`real ${realPct.toFixed(1)}%  `).width + 4;
    if (ex < L.profX1 - 30) ctx.fillText(`▨ est`, ex, fy + 12);
  }

  private drawPriceAxis() {
    const m = this.model!;
    const ctx = this.ctx;
    const P = this.pal;
    const L = this.L;
    ctx.fillStyle = P.panel;
    ctx.fillRect(L.axisX0, 0, L.axisX1 - L.axisX0, L.deltaY0);
    const step = this.gridStep();
    const dp = this.priceDp(step);
    ctx.font = `10px ${MONO}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = P.dim;
    const uTop = this.uOf(L.mainY0);
    const uBot = this.uOf(L.mainY1);
    for (let u = Math.floor(uBot / step) * step; u <= uTop; u += step) {
      const y = this.yOf(u);
      if (y < L.mainY0 + 6 || y > L.mainY1 - 6) continue;
      ctx.fillText(formatUnits(u, dp), L.axisX0 + 6, y);
    }
    // level tags
    const row = m.settings.rowUnits;
    const tags: Array<{ u: number; text: string; color: string; fg?: string }> = [];
    const cur = m.sessions[m.sessions.length - 1];
    const fdp = this.priceDp();
    if (this.meta.lastPrice != null) {
      const lb = m.bars[m.bars.length - 1];
      tags.push({ u: this.meta.lastPrice + this.meta.tick / 2, text: formatUnits(this.meta.lastPrice, fdp), color: lb && lb.c < lb.o ? P.sell : P.buy, fg: "#fff" });
    }
    if (cur?.va) {
      tags.push({ u: (cur.va.poc + 0.5) * row, text: "POC " + formatUnits(cur.va.poc * row, fdp), color: P.poc, fg: "#111" });
      tags.push({ u: (cur.va.vah + 1) * row, text: "VAH " + formatUnits((cur.va.vah + 1) * row, fdp), color: P.va, fg: "#fff" });
      tags.push({ u: cur.va.val * row, text: "VAL " + formatUnits(cur.va.val * row, fdp), color: P.va, fg: "#fff" });
    }
    const pr = m.ctx.prior;
    if (pr?.va) {
      tags.push({ u: (pr.va.poc + 0.5) * row, text: "pPOC", color: P.prior, fg: "#fff" });
      tags.push({ u: (pr.va.vah + 1) * row, text: "pVAH", color: P.prior, fg: "#fff" });
      tags.push({ u: pr.va.val * row, text: "pVAL", color: P.prior, fg: "#fff" });
    }
    const used: number[] = [];
    ctx.font = `600 10px ${MONO}`;
    for (const t of tags) {
      let y = this.yOf(t.u);
      if (y < L.mainY0 + 7 || y > L.mainY1 - 7) continue;
      if (used.some((uy) => Math.abs(uy - y) < 14)) continue;
      used.push(y);
      ctx.fillStyle = t.color;
      ctx.fillRect(L.axisX0 + 1, y - 7, L.axisX1 - L.axisX0 - 2, 14);
      ctx.fillStyle = t.fg ?? P.bg;
      ctx.fillText(t.text, L.axisX0 + 5, y + 0.5);
    }
  }

  private timeStepMinutes(): number {
    const tf = this.model!.settings.tfMin;
    const minPx = 74;
    const cands = [1, 2, 5, 10, 15, 30, 60, 120, 180, 240, 360, 720, 1440];
    for (const c of cands) if (c >= tf && (c / tf) * this.barW >= minPx) return c;
    return 1440;
  }

  private timeLabelIdx(i0: number, i1: number): number[] {
    const m = this.model!;
    const step = this.timeStepMinutes() * 60_000;
    const out: number[] = [];
    let lastX = -1e9;
    for (let i = i0; i <= i1; i++) {
      const t = m.bars[i].t;
      if (t % step === 0) {
        const x = this.xLeft(i);
        if (x - lastX >= 60) {
          out.push(i);
          lastX = x;
        }
      }
    }
    return out;
  }

  private drawTimeAxis(i0: number, i1: number) {
    const m = this.model!;
    const ctx = this.ctx;
    const P = this.pal;
    const L = this.L;
    ctx.fillStyle = P.panel;
    ctx.fillRect(0, L.timeY0, L.w, L.timeY1 - L.timeY0);
    ctx.font = `10px ${MONO}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const tz = this.meta.tz;
    const y = (L.timeY0 + L.timeY1) / 2;
    for (const i of this.timeLabelIdx(i0, i1)) {
      const t = m.bars[i].t;
      const x = this.xLeft(i);
      if (x < L.plotX0 + 20 || x > L.plotX1 - 20) continue;
      const isSess = m.sessions[m.sessionOfBar[i]]?.i0 === i;
      ctx.fillStyle = isSess ? P.text : P.dim;
      ctx.fillText(isSess || t % 86_400_000 === 0 ? fmtDateTime(t, tz) : fmtTime(t, tz), x, y);
    }
    ctx.fillStyle = P.faint;
    ctx.textAlign = "right";
    ctx.fillText(tz === "local" ? "local" : tz === "UTC" ? "UTC" : "NY", L.axisX1 - 6, y);
  }

  private drawLegend() {
    const m = this.model!;
    const ctx = this.ctx;
    const P = this.pal;
    const L = this.L;
    let i = this.n - 1;
    if (this.mouse && this.mouse.x < L.plotX1) {
      const k = this.idxAt(this.mouse.x);
      if (k >= 0 && k < this.n) i = k;
    }
    const b = m.bars[i];
    if (!b) return;
    const dp = this.priceDp();
    const x = 8;
    const y = L.mainY0 + 18;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = `600 12px ${SANS}`;
    ctx.fillStyle = P.text;
    const title = this.meta.title;
    ctx.fillText(title, x, y);
    let cx = x + ctx.measureText(title).width + 10;
    ctx.font = `10px ${SANS}`;
    ctx.fillStyle = P.dim;
    ctx.fillText(this.meta.subtitle, cx, y);
    // bar readout
    ctx.font = `10px ${MONO}`;
    const src = barSource(b);
    const parts: Array<[string, string]> = [
      [fmtDateTime(b.t, this.meta.tz), P.dim],
      ["O " + formatUnits(b.o, dp), P.text],
      ["H " + formatUnits(b.h, dp), P.text],
      ["L " + formatUnits(b.l, dp), P.text],
      ["C " + formatUnits(b.c, dp), P.text],
      ["V " + fmtVol(b.vol), P.text],
      [
        b.buy + b.sell > 0 ? "Δ " + fmtSigned(b.realDelta) + (b.estVol > 0 ? " (partial)" : "") : this.meta.estDelta ? "Δ ~" + fmtSigned(b.estDelta) + " est" : "Δ n/a",
        b.buy + b.sell > 0 ? (b.realDelta >= 0 ? P.buyText : P.sellText) : P.est,
      ],
      [src === "real" ? "real trades" : src === "mixed" ? "partly real" : "estimated", src === "est" ? P.est : P.cvd],
    ];
    cx = x;
    const y2 = y + 16;
    for (const [t, c] of parts) {
      ctx.fillStyle = c;
      ctx.fillText(t, cx, y2);
      cx += ctx.measureText(t).width + 10;
    }
  }

  private drawCrosshair() {
    const mo = this.mouse;
    if (!mo || this.drag) {
      this.tip.style.display = "none";
      return;
    }
    const m = this.model!;
    const ctx = this.ctx;
    const P = this.pal;
    const L = this.L;
    const inMain = mo.y >= L.mainY0 && mo.y <= L.mainY1 && mo.x <= L.axisX0;
    const inLower = mo.y > L.mainY1 && mo.y < L.timeY0 && mo.x <= L.plotX1;
    if (!inMain && !inLower) {
      this.tip.style.display = "none";
      return;
    }
    ctx.strokeStyle = P.cross;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    if (mo.x <= L.plotX1) {
      const i = this.idxAt(mo.x);
      const xc = Math.round(this.xLeft(i) + this.barW / 2) + 0.5;
      ctx.moveTo(xc, L.mainY0);
      ctx.lineTo(xc, L.timeY0);
      if (i >= 0 && i < this.n) {
        const t = m.bars[i].t;
        ctx.stroke();
        ctx.setLineDash([]);
        const label = fmtDateTime(t, this.meta.tz);
        ctx.font = `10px ${MONO}`;
        const w = ctx.measureText(label).width + 10;
        ctx.fillStyle = P.cross;
        ctx.fillRect(xc - w / 2, L.timeY0 + 2, w, L.timeY1 - L.timeY0 - 4);
        ctx.fillStyle = P.bg;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, xc, (L.timeY0 + L.timeY1) / 2);
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
      }
    }
    if (inMain) {
      const y = Math.round(mo.y) + 0.5;
      ctx.moveTo(L.plotX0, y);
      ctx.lineTo(L.axisX0, y);
      ctx.stroke();
      ctx.setLineDash([]);
      const u = this.uOf(mo.y);
      ctx.fillStyle = P.cross;
      ctx.fillRect(L.axisX0 + 1, y - 8, L.axisX1 - L.axisX0 - 2, 16);
      ctx.fillStyle = P.bg;
      ctx.font = `600 10px ${MONO}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(formatUnits(Math.round(u / this.meta.tick) * this.meta.tick, this.priceDp()), L.axisX0 + 5, y);
    } else ctx.stroke();
    ctx.setLineDash([]);
    this.updateTooltip(mo, inMain);
  }

  private updateTooltip(mo: { x: number; y: number }, inMain: boolean) {
    const m = this.model!;
    const L = this.L;
    const row = m.settings.rowUnits;
    const dp = Math.max(this.priceDp(), decimalsFor(row));
    const r = Math.floor(this.uOf(mo.y) / row);
    const lines: string[] = [];
    if (inMain && mo.x >= L.profX0 && mo.x < L.axisX0) {
      const s = this.profileSession();
      if (s) {
        const p = s.profile;
        const i = r - p.lo;
        if (i >= 0 && i < p.vol.length && p.vol[i] > 0) {
          lines.push(`<b>${formatUnits(r * row, dp)} – ${formatUnits((r + 1) * row, dp)}</b>`);
          lines.push(`session vol <b>${fmtVol(p.vol[i])}</b> (${((p.vol[i] / p.total) * 100).toFixed(2)}%)`);
          if (p.buy[i] + p.sell[i] > 0) lines.push(`real: buy ${fmtVol(p.buy[i])} · sell ${fmtVol(p.sell[i])} · Δ ${fmtSigned(p.buy[i] - p.sell[i])}`);
          if (p.est[i] > 0) lines.push(`<span class="est">estimated from candles: ${fmtVol(p.est[i])}</span>`);
          if (s.va && r === s.va.poc) lines.push(`<span class="poc">POC</span>`);
        }
      }
    } else if (mo.x < L.plotX1) {
      const i = this.idxAt(mo.x);
      const b = m.bars[i];
      if (b) {
        if (inMain) {
          const c = b.cells.get(r);
          if (c) {
            lines.push(`<b>${formatUnits(r * row, dp)} – ${formatUnits((r + 1) * row, dp)}</b>`);
            if (c.b + c.s > 0) {
              lines.push(`sell (hit bid) <b class="sell">${fmtVol(c.s)}</b> · buy (lift ask) <b class="buy">${fmtVol(c.b)}</b>`);
              lines.push(`cell Δ ${fmtSigned(c.b - c.s)}`);
              const im = m.barInfo(b).imb.filter((x) => x.row === r);
              for (const x of im) lines.push(`<span class="${x.side}">${x.side} imbalance ${Number.isFinite(x.ratio) ? (x.ratio * 100).toFixed(0) + "%" : "vs 0"}</span>`);
            }
            if (c.e > 0) lines.push(`<span class="est">~${fmtVol(c.e)} estimated (1m candle range, side unknown)</span>`);
          }
        } else {
          const cvd = m.cvd[i];
          lines.push(`<b>${fmtDateTime(b.t, this.meta.tz)}</b>`);
          lines.push(`real Δ ${fmtSigned(b.realDelta)} · buy ${fmtVol(b.buy)} · sell ${fmtVol(b.sell)}`);
          if (b.estVol > 0) lines.push(`<span class="est">est vol ${fmtVol(b.estVol)} · close-location Δ ~${fmtSigned(b.estDelta)}</span>`);
          lines.push(`CVD ${fmtSigned(cvd)}`);
        }
      }
    }
    if (!lines.length) {
      this.tip.style.display = "none";
      return;
    }
    this.tip.innerHTML = lines.join("<br>");
    this.tip.style.display = "block";
    const tw = this.tip.offsetWidth;
    const th = this.tip.offsetHeight;
    let x = mo.x + 14;
    let y = mo.y + 14;
    if (x + tw > L.w - 4) x = mo.x - tw - 14;
    if (y + th > L.h - 4) y = mo.y - th - 14;
    this.tip.style.transform = `translate(${Math.max(2, x)}px, ${Math.max(2, y)}px)`;
  }

  // ---------- interaction ----------
  private bindEvents() {
    const c = this.canvas;
    c.style.touchAction = "none";
    const pos = (e: PointerEvent | WheelEvent | MouseEvent) => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    c.addEventListener("pointermove", (e) => {
      const p = pos(e);
      this.mouse = p;
      const L = this.L;
      c.style.cursor = p.x >= L.axisX0 && p.y < L.mainY1 ? "ns-resize" : this.drag ? "grabbing" : "crosshair";
      if (this.drag) {
        const d = this.drag;
        const dx = p.x - d.x;
        const dy = p.y - d.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
        if (d.mode === "pan") {
          this.scroll = d.scroll + dx / this.barW;
          if (Math.abs(dx) > 3) this.follow = false;
          if (!this.autoY || Math.abs(dy) > 24) {
            if (this.autoY) {
              this.autoY = false;
              d.centerU = this.centerU;
              d.y = p.y;
            } else this.centerU = d.centerU + (p.y - d.y) * this.upp;
          }
        } else {
          this.autoY = false;
          this.upp = Math.max(1, d.upp * Math.exp(dy / 160));
        }
        this.onViewChange?.();
      }
      this.request();
    });
    c.addEventListener("pointerleave", () => {
      this.mouse = null;
      this.request();
    });
    c.addEventListener("pointerdown", (e) => {
      const p = pos(e);
      c.setPointerCapture(e.pointerId);
      const L = this.L;
      const mode = p.x >= L.axisX0 && p.y < L.mainY1 ? "yzoom" : "pan";
      if (mode === "yzoom" && this.autoY) {
        this.autoY = false;
      }
      this.drag = { x: p.x, y: p.y, scroll: this.scroll, centerU: this.centerU, upp: this.upp, mode, moved: false };
    });
    const end = (e: PointerEvent) => {
      if (this.drag) {
        try {
          c.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      }
      this.drag = null;
      this.request();
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
    c.addEventListener("dblclick", (e) => {
      const p = pos(e);
      if (p.x >= this.L.axisX0) this.autoY = true;
      else this.resetView(this.barW);
      this.onViewChange?.();
    });
    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const p = pos(e);
        const L = this.L;
        if (p.x >= L.axisX0 || e.ctrlKey || e.altKey) {
          // vertical zoom around the cursor price
          const u = this.uOf(p.y);
          const f = Math.exp((e.deltaY > 0 ? 1 : -1) * 0.12);
          this.autoY = false;
          this.upp = Math.max(1, this.upp * f);
          this.centerU = u - (this.midY - p.y) * this.upp;
        } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
          const d = e.shiftKey ? e.deltaY : e.deltaX;
          this.scroll += d / this.barW;
          this.follow = this.scroll <= 0 && this.follow;
          if (d < 0) this.follow = false;
        } else {
          // horizontal zoom keeping the bar under the cursor fixed
          const before = (this.L.plotX1 - RIGHT_PAD - p.x) / this.barW;
          const f = Math.exp((e.deltaY > 0 ? -1 : 1) * 0.12);
          this.barW = Math.max(2, Math.min(240, this.barW * f));
          const after = (this.L.plotX1 - RIGHT_PAD - p.x) / this.barW;
          if (!this.follow) this.scroll += after - before;
        }
        this.onViewChange?.();
        this.request();
      },
      { passive: false },
    );
    c.addEventListener("keydown", (e) => {
      let handled = true;
      if (e.key === "ArrowLeft") {
        this.scroll += 3;
        this.follow = false;
      } else if (e.key === "ArrowRight") {
        this.scroll = Math.max(0, this.scroll - 3);
      } else if (e.key === "+" || e.key === "=") this.barW = Math.min(240, this.barW * 1.2);
      else if (e.key === "-") this.barW = Math.max(2, this.barW / 1.2);
      else if (e.key === "Home" || e.key === "End" || e.key === "0") this.resetView(this.barW);
      else handled = false;
      if (handled) {
        e.preventDefault();
        this.request();
      }
    });
  }
}
