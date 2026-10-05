/**
 * ChartModel: turns a MarketFeed's minute data into everything the renderer
 * and the context panel need, for the current settings. Pure data, no DOM.
 */
import {
  cvdDivergences,
  failedAuctions,
  lowVolumeNodes,
  nakedPocs,
  poorExtremes,
  sessionRefs,
  singlePrints,
  type FailedAuction,
  type NakedPoc,
  type PoorExtreme,
  type RowRange,
} from "./analytics/auction";
import { MINUTE } from "./analytics/footprint";
import { diagonalImbalances, stackedImbalances, type Imbalance } from "./analytics/imbalance";
import { barDelta, buildBars, buildSessions, minuteKeys, type MinuteSource, type SessionStats } from "./analytics/series";
import type { SessionSpec } from "./analytics/session";
import { barSource, type Bar } from "./analytics/types";

export interface ModelSettings {
  tfMin: number;
  rowUnits: number;
  session: SessionSpec;
  vaPct: number;
  /** diagonal imbalance ratio, e.g. 3 = 300% */
  imbRatio: number;
  /** include close-location estimated delta in CVD / bar delta */
  estDelta: boolean;
  /** how many prior sessions to scan for naked POCs */
  nakedLookback: number;
  /** bars of lookback for CVD divergence */
  divLookback: number;
}

export interface DivergenceMark {
  idx: number;
  refIdx: number;
  kind: "bearish" | "bullish";
  quality: "real" | "est";
}

export interface Context {
  /** session index the context refers to (the latest session) */
  sessionIdx: number;
  prior: SessionStats | null;
  lvn: RowRange[];
  singlePrints: RowRange[];
  poor: PoorExtreme[];
  failed: FailedAuction[];
  naked: NakedPoc[];
  divergences: DivergenceMark[];
}

export class ChartModel {
  bars: Bar[] = [];
  sessions: SessionStats[] = [];
  /** bar index -> session index */
  sessionOfBar: number[] = [];
  cvd: number[] = [];
  /** per bar: whether all of the bar's delta is real */
  realBar: boolean[] = [];
  ctx: Context = emptyCtx();
  settings: ModelSettings;
  version = 0;
  buildMs = 0;
  private imbCache = new WeakMap<Bar, { imb: Imbalance[]; stacked: ReturnType<typeof stackedImbalances>; poc: number | null; maxCell: number }>();

  constructor(settings: ModelSettings) {
    this.settings = settings;
  }

  build(src: MinuteSource | null): void {
    const t0 = performance.now();
    if (!src) {
      this.bars = [];
      this.sessions = [];
      this.sessionOfBar = [];
      this.cvd = [];
      this.realBar = [];
      this.ctx = emptyCtx();
      this.version++;
      return;
    }
    const s = this.settings;
    const keys = minuteKeys(src);
    this.bars = buildBars(src, keys, s.tfMin * MINUTE, s.rowUnits, s.session);
    this.sessions = buildSessions(this.bars, s.vaPct);
    this.sessionOfBar = new Array(this.bars.length);
    this.sessions.forEach((ss, k) => {
      for (let i = ss.i0; i <= ss.i1; i++) this.sessionOfBar[i] = k;
    });
    this.realBar = this.bars.map((b) => barSource(b) === "real");
    // CVD resets each session
    this.cvd = new Array(this.bars.length);
    for (const ss of this.sessions) {
      let acc = 0;
      for (let i = ss.i0; i <= ss.i1; i++) {
        acc += barDelta(this.bars[i], s.estDelta);
        this.cvd[i] = acc;
      }
    }
    this.ctx = this.buildContext();
    this.version++;
    this.buildMs = performance.now() - t0;
  }

  private buildContext(): Context {
    const s = this.settings;
    const n = this.sessions.length;
    if (!n) return emptyCtx();
    const cur = this.sessions[n - 1];
    const prior = n >= 2 ? this.sessions[n - 2] : null;
    const curBars = this.bars.slice(cur.i0, cur.i1 + 1);
    const lvn = lowVolumeNodes(cur.profile, 0.15, 2);
    const sp = singlePrints(curBars, s.rowUnits, 2);
    const poor = curBars.length >= 6 ? poorExtremes(cur.profile) : [];
    let failed: FailedAuction[] = [];
    if (prior) {
      const refs = sessionRefs(prior.va, prior.high, prior.low, s.rowUnits, "prior");
      failed = failedAuctions(
        this.bars,
        cur.i0,
        cur.i1,
        refs,
        (i) => barDelta(this.bars[i], s.estDelta),
        (i) => this.realBar[i],
      );
    }
    const from = Math.max(0, n - 1 - s.nakedLookback);
    const naked = nakedPocs(
      this.sessions.slice(from).map((x) => ({ start: x.start, poc: x.va?.poc ?? null, i1: x.i1 })),
      this.bars,
      s.rowUnits,
    );
    // divergences, evaluated within each session (CVD resets at session start)
    const divergences: DivergenceMark[] = [];
    for (const ss of this.sessions.slice(-2)) {
      const bs = this.bars.slice(ss.i0, ss.i1 + 1);
      const cv = this.cvd.slice(ss.i0, ss.i1 + 1);
      let prev: DivergenceMark | null = null;
      for (const d of cvdDivergences(bs, cv, s.divLookback)) {
        const idx = d.idx + ss.i0;
        const refIdx = d.refIdx + ss.i0;
        let real = true;
        for (let i = refIdx; i <= idx; i++) if (!this.realBar[i]) real = false;
        const mark: DivergenceMark = { idx, refIdx, kind: d.kind, quality: real ? "real" : "est" };
        // collapse runs: keep a flag only when it starts a new run or references a new extreme
        if (prev && prev.kind === mark.kind && prev.idx === idx - 1 && prev.refIdx === refIdx) {
          prev = mark;
          continue;
        }
        divergences.push(mark);
        prev = mark;
      }
    }
    // without estimated delta, historical (est-only) bars have zero delta; don't flag those
    const divs = s.estDelta ? divergences : divergences.filter((d) => d.quality === "real" || this.bars[d.idx].buy + this.bars[d.idx].sell > 0);
    return { sessionIdx: n - 1, prior, lvn, singlePrints: sp, poor, failed, naked, divergences: divs };
  }

  /** Per-bar derived data (imbalances, bar POC, max cell) — cached per Bar object. */
  barInfo(b: Bar) {
    let c = this.imbCache.get(b);
    if (!c) {
      const imb = diagonalImbalances(b.cells, this.settings.imbRatio);
      let poc: number | null = null;
      let best = -1;
      let maxCell = 0;
      for (const [r, cell] of b.cells) {
        const v = cell.b + cell.s + cell.e;
        if (v > best) {
          best = v;
          poc = r;
        }
        if (v > maxCell) maxCell = v;
      }
      c = { imb, stacked: stackedImbalances(imb, 3), poc, maxCell };
      this.imbCache.set(b, c);
    }
    return c;
  }

  invalidateBarInfo(): void {
    this.imbCache = new WeakMap();
  }
}

function emptyCtx(): Context {
  return { sessionIdx: -1, prior: null, lvn: [], singlePrints: [], poor: [], failed: [], naked: [], divergences: [] };
}
