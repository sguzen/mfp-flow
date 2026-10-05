/**
 * App shell: market picker + settings → MarketFeed (public MFP stream) →
 * ChartModel (pure analytics) → FootprintChart (canvas) + context panel.
 * No API key anywhere: everything comes from the public market-data socket.
 */
import "./style.css";
import { locationVsValue, valueRelation } from "./analytics/auction";
import { decimalsFor, formatUnits, PRICE_SCALE } from "./analytics/price";
import type { SessionMode } from "./analytics/session";
import { MarketFeed, type FeedChange } from "./data/feed";
import { DEFAULT_MARKET_ID, defaultSession, isTradFi, loadMarkets, marketLabel, type Market } from "./data/markets";
import { loadMinutes, saveMinutes } from "./data/persist";
import { binanceSymbol, fetchOiHistory } from "./data/binance-oi";
import { fetchRecorder, mergeRestored } from "./data/recorder";
import { MarketStream } from "./data/stream";
import { allowanceShare, getAccountState, getAccounts, getQuote, inExtension, keyStatus, type AccountSummary } from "./ext/account";
import { parseEmbed, isMarketMessage } from "./ext/embed";
import { matchMarket } from "./ext/market-from-url";
import { classifyMarket } from "./risk/costs";
import { buildOverlay, type OrderLike, type PositionLike } from "./risk/overlay";
import { nextDailyReset } from "./risk/time";
import { HELP } from "./help";
import { parseLink, serializeLink, type LinkState } from "./link";
import { ChartModel, type ViewMode } from "./model";
import { FootprintChart } from "./render/chart";
import { composeSnapshot, snapshotCaption, snapshotFilename } from "./render/snapshot";
import { fmtDate, fmtDateTime, fmtSigned, fmtTime, fmtUsd, fmtVol, type TimeZoneMode } from "./render/format";
import { readPalette } from "./render/theme";

// ---------- persisted UI settings (best effort) ----------
interface UiSettings {
  market: string;
  view: ViewMode;
  days: number;
  rightProfile: "session" | "composite";
  tf: number;
  rowByMarket: Record<string, number>;
  sessionByMarket: Record<string, SessionMode>;
  markers: boolean;
  divergence: boolean;
  estDelta: boolean;
  imb: number;
  va: number;
  tz: TimeZoneMode;
  /** which series fills the lower pane */
  lower: "cvd" | "oi";
  /** optional recorder service base URL (see recorder/) */
  recorderUrl: string;
  theme: "dark" | "light";
  panel: boolean;
}
const KEY = "mfp-flow:ui:v1";
const defaults: UiSettings = {
  market: DEFAULT_MARKET_ID,
  view: "footprint",
  days: 3,
  rightProfile: "session",
  tf: 5,
  rowByMarket: {},
  sessionByMarket: {},
  markers: true,
  divergence: true,
  estDelta: false,
  imb: 3,
  va: 0.7,
  tz: "local",
  lower: "cvd",
  recorderUrl: "",
  theme: "dark",
  panel: true,
};
function loadUi(): UiSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...defaults, ...JSON.parse(raw) };
  } catch {
    /* storage blocked */
  }
  const light = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches;
  return { ...defaults, theme: light ? "light" : "dark" };
}
function saveUi() {
  try {
    localStorage.setItem(KEY, JSON.stringify(ui));
  } catch {
    /* ignore */
  }
}
const ui = loadUi();
/** per-market link parts, consumed by the first selectMarket() */
let pendingLink: LinkState | null = null;
const bootLink = parseLink(location.hash);
/** Set when running as the in-terminal panel (see src/ext/embed.ts). */
const embed = parseEmbed(location.hash);
if (embed.embed) {
  document.documentElement.classList.add("embed");
  // tell the host page we actually loaded; a blocked iframe never gets here
  try {
    parent?.postMessage({ source: "mfp-flow", type: "ready" }, "*");
  } catch {
    /* no parent, or a cross-origin parent that refuses */
  }
} else applyLink(bootLink);

// ---------- deep links ----------
// The hash carries the whole view (see src/link.ts). Anything it specifies wins
// over the saved settings, so a shared link reproduces the sender's chart.
function marketFromToken(markets: Market[], token: string | undefined): string | null {
  if (!token) return null;
  const up = token.trim().toUpperCase();
  if (!up) return null;
  const m =
    markets.find((x) => x.market_id.toUpperCase() === up) ??
    markets.find((x) => x.coin.toUpperCase() === up || x.coin.toUpperCase() === `XYZ:${up}`) ??
    markets.find((x) => x.symbol.toUpperCase() === up);
  return m?.market_id ?? null;
}

/**
 * Fold the view-wide parts of a link into `ui`. `row` and `session` are
 * per-market, so they wait for the market to resolve (see `pendingLink`).
 */
function applyLink(l: LinkState) {
  if (l.view) ui.view = l.view;
  if (l.tf != null) ui.tf = l.tf;
  if (l.days != null) ui.days = l.days;
  if (l.rightProfile) ui.rightProfile = l.rightProfile;
  pendingLink = l.row != null || l.session ? l : null;
}

/** Push `ui` back into the controls, after a link changed it under them. */
function syncControls() {
  for (const b of elTf.querySelectorAll("button")) {
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(Number((b as HTMLElement).dataset.v) === ui.tf));
  }
  for (const b of elView.querySelectorAll("button")) {
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String((b as HTMLElement).dataset.v === ui.view));
  }
  elDays.value = String(ui.days);
  elRprof.value = ui.rightProfile;
  if (market) {
    elMarket.value = market.market_id;
    elSession.value = sessionModeFor(market);
  }
}

/** Rewrite the hash to the current view, without touching history. */
function syncHash() {
  if (!market) return;
  const body = serializeLink({
    market: market.market_id,
    view: ui.view,
    tf: ui.tf,
    days: ui.days,
    rightProfile: ui.rightProfile,
    // only once a real row is in force for this market
    row: feed?.buckets ? model.settings.rowUnits / PRICE_SCALE : undefined,
    session: sessionModeFor(market),
  });
  const next = `#${body}`;
  // replaceState does not fire hashchange, so this cannot loop
  if (location.hash !== next) history.replaceState(null, "", next);
}

// ---------- DOM ----------
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const elMarket = $<HTMLSelectElement>("market");
const elTf = $<HTMLDivElement>("tf");
const elView = $<HTMLDivElement>("view");
const elDays = $<HTMLSelectElement>("days");
const elRprof = $<HTMLSelectElement>("rprof");
const elRow = $<HTMLSelectElement>("row");
const elSession = $<HTMLSelectElement>("session");
const elMarkers = $<HTMLInputElement>("optMarkers");
const elDiv = $<HTMLInputElement>("optDiv");
const elEst = $<HTMLInputElement>("optEst");
const elImb = $<HTMLSelectElement>("optImb");
const elVa = $<HTMLSelectElement>("optVa");
const elTz = $<HTMLSelectElement>("optTz");
const elStatus = $<HTMLDivElement>("status");
const elPanel = $<HTMLElement>("panel");
const host = $<HTMLElement>("chart");

document.documentElement.dataset.theme = ui.theme;
/** Panel visibility is a view state; embed starts collapsed without saving that. */
let panelOpen = embed.embed ? false : ui.panel;
document.body.classList.toggle("panel-hidden", !panelOpen);

const chart = new FootprintChart(host);
const empty = document.createElement("div");
empty.className = "empty";
host.appendChild(empty);

const stream = new MarketStream();
stream.connect();

let markets: Market[] = [];
let marketsNote: string | undefined;
let recorderNote: string | null = null;
let oiNote: string | null = null;
let feed: MarketFeed | null = null;
let market: Market | null = null;

const sessionModeFor = (m: Market): SessionMode => ui.sessionByMarket[m.market_id] ?? defaultSession(m).mode;

const model = new ChartModel({
  tfMin: ui.tf,
  rowUnits: 1,
  session: { mode: "utc" },
  vaPct: ui.va,
  imbRatio: ui.imb,
  estDelta: ui.estDelta,
  nakedLookback: ui.days,
  divLookback: 12,
  view: ui.view,
  rightProfile: ui.rightProfile,
  compositeDays: ui.days,
});

// ---------- status ----------
stream.onStatus((s) => {
  elStatus.dataset.state = s.state;
  const txt = elStatus.querySelector(".txt")!;
  if (s.state === "open") txt.textContent = `live${s.rttMs != null ? ` · ${Math.round(s.rttMs)} ms` : ""}`;
  else if (s.state === "reconnecting") txt.textContent = `reconnecting${s.attempt ? ` (#${s.attempt})` : ""}…`;
  else txt.textContent = s.state;
});

// ---------- rebuild loop (throttled) ----------
let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
let lastBuild = 0;
function schedule(kind?: FeedChange) {
  if (kind === "status") {
    renderPanel();
    return;
  }
  if (rebuildTimer) return;
  const wait = Math.max(0, 250 - (performance.now() - lastBuild));
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    rebuild();
  }, wait);
}

/** Row size is remembered per market and per view family (footprint vs profiles/TPO). */
function rowKey(m: Market): string {
  return ui.view === "footprint" ? m.market_id : `${m.market_id}|profile`;
}

function rowOptions(): number[] {
  return feed?.buckets?.options ?? [];
}

function syncRowSelect() {
  const opts = rowOptions();
  if (!feed?.buckets || !market) {
    elRow.innerHTML = "<option>—</option>";
    elRow.disabled = true;
    return;
  }
  const key = rowKey(market);
  let row = ui.rowByMarket[key];
  if (!row || !opts.includes(row)) {
    const d = feed.buckets.defaultUnits;
    // Profiles/TPO read better with coarser rows (BTC 10 -> 50, NAS100 5 -> 25)
    row = ui.view === "footprint" ? d : opts.find((o) => o >= d * 5) ?? opts[opts.length - 1];
  }
  const sig = opts.join(",") + "|" + row;
  if (elRow.dataset.sig !== sig) {
    elRow.innerHTML = opts.map((o) => `<option value="${o}"${o === row ? " selected" : ""}>${formatUnits(o, decimalsFor(o))}</option>`).join("");
    elRow.dataset.sig = sig;
  }
  elRow.disabled = false;
  model.settings.rowUnits = row;
}

function rebuild() {
  lastBuild = performance.now();
  if (!feed || !market) return;
  syncRowSelect();
  const src = feed.source();
  if (!src || !feed.buckets) {
    model.build(null);
    chart.setModel(model);
    showEmpty();
    renderPanel();
    return;
  }
  model.settings.session = { mode: sessionModeFor(market) };
  model.settings.tfMin = ui.tf;
  model.settings.vaPct = ui.va;
  model.settings.estDelta = ui.estDelta;
  model.settings.view = ui.view;
  model.settings.rightProfile = ui.rightProfile;
  model.settings.compositeDays = ui.days;
  model.settings.nakedLookback = ui.days;
  model.build(src);
  chart.setModel(model);
  chart.setMeta({
    lastPrice: feed.lastPrice,
    tick: feed.tick || feed.book?.fine || 1,
    realSince: feed.realSince(),
    tz: ui.tz,
    title: marketLabel(market),
    subtitle: `${market.provider} · ${ui.view === "tpo" ? "TPO 30m" : `${ui.tf}m`} · row ${formatUnits(model.settings.rowUnits, decimalsFor(model.settings.rowUnits))}`,
    showMarkers: ui.markers,
    showDivergence: ui.divergence,
    estDelta: ui.estDelta,
    lowerPane: ui.lower,
  });
  showEmpty();
  renderPanel();
  syncHash();
}

function showEmpty() {
  if (model.bars.length) {
    empty.style.display = "none";
    return;
  }
  empty.style.display = "grid";
  const h = feed?.history;
  if (feed?.error) empty.textContent = `Couldn't load ${market ? marketLabel(market) : "market"}: ${feed.error}`;
  else if (h?.state === "error") empty.textContent = `History unavailable (${h.message ?? "error"}). Waiting for live trades…`;
  else empty.textContent = `Loading ${market ? marketLabel(market) : ""} history…`;
}

// ---------- market switching ----------
async function selectMarket(id: string) {
  const m = markets.find((x) => x.market_id === id) ?? markets.find((x) => x.market_id === DEFAULT_MARKET_ID) ?? markets[0];
  if (!m) return;
  if (feed) {
    feed.stop();
    feed = null;
  }
  market = m;
  ui.market = m.market_id;
  if (pendingLink) {
    // rowKey() depends on ui.view, which applyLink() has already set
    if (pendingLink.session) ui.sessionByMarket[m.market_id] = pendingLink.session;
    if (pendingLink.row != null) ui.rowByMarket[rowKey(m)] = Math.round(pendingLink.row * PRICE_SCALE);
    pendingLink = null;
  }
  saveUi();
  elMarket.value = m.market_id;
  elSession.value = sessionModeFor(m);
  syncHash();
  document.title = `${marketLabel(m)} · mfp·flow`;
  chart.resetView(defaultBarW());
  model.build(null);
  chart.setModel(model);
  showEmpty();
  oiNote = null;
  const f = new MarketFeed(stream, m, {
    priorSessions: Math.max(1, ui.days - 1),
    session: { mode: sessionModeFor(m) },
    persist: {
      // the browser's own recording first, then anything a recorder service has
      // for the same window; both are real trades, so they merge before the
      // feed falls back to estimating from candles
      load: async (mid, fine, since) => {
        const local = await loadMinutes(mid, fine, since);
        if (!ui.recorderUrl) return local;
        const got = await fetchRecorder(ui.recorderUrl, mid, fine, since);
        recorderNote = got.note;
        return mergeRestored(local, got.restored);
      },
      save: (mid, fine, minutes, segments) => saveMinutes(mid, fine, minutes, segments),
    },
    onChange: (k) => {
      if (feed === f) schedule(k);
    },
  });
  feed = f;
  renderPanel();
  // Binance publishes OI history for its own perps; MFP keeps none, and
  // Hyperliquid only exposes a current value that duplicates MFP's live one.
  // Runs alongside start() because it is independent of the trade stream.
  const sym = binanceSymbol(m);
  const backfill = sym
    ? fetchOiHistory(sym, ui.days).then((r) => {
        if (feed !== f) return;
        oiNote = r.note;
        if (r.history) {
          f.mergeOi(r.history.points.map((p) => ({ t: p.t, usd: p.usd })));
          oiNote = `OI history from Binance, ${r.history.period} resolution (coarser than the bars).`;
        }
      })
    : Promise.resolve((oiNote = "No OI history for this venue; live OI only."));
  try {
    await f.start();
  } catch (e) {
    f.error = (e as Error).message;
  }
  void backfill.then(() => feed === f && schedule());
  if (feed === f) schedule();
}

// ---------- controls ----------
function setTf(v: number) {
  ui.tf = v;
  saveUi();
  for (const b of elTf.querySelectorAll("button")) b.setAttribute("aria-checked", String(Number(b.dataset.v) === v));
  for (const b of elTf.querySelectorAll("button")) b.setAttribute("role", "radio");
  chart.resetView(defaultBarW());
  schedule();
}

/** Bar width that fits the view: footprint shows cells, Profiles/TPO fit ~3.5 sessions. */
function defaultBarW(): number {
  if (ui.view === "footprint") return innerWidth < 600 ? 44 : ui.tf >= 15 ? 110 : 84;
  const plotW = Math.max(300, host.clientWidth - 300);
  const perSession = 1440 / ui.tf;
  return Math.max(0.6, Math.min(40, plotW / (perSession * 3.5)));
}

function setView(v: ViewMode) {
  ui.view = v;
  saveUi();
  helpOnView(v);
  for (const b of elView.querySelectorAll("button")) {
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(b.dataset.v === v));
  }
  chart.resetView(defaultBarW());
  schedule();
}
elView.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (b?.dataset.v) setView(b.dataset.v as ViewMode);
});
elDays.value = String(ui.days);
elDays.addEventListener("change", () => {
  ui.days = Number(elDays.value);
  saveUi();
  if (market) void selectMarket(market.market_id);
});
elRprof.value = ui.rightProfile;
elRprof.addEventListener("change", () => {
  ui.rightProfile = elRprof.value as "session" | "composite";
  saveUi();
  schedule();
});
elTf.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (b?.dataset.v) setTf(Number(b.dataset.v));
});
elMarket.addEventListener("change", () => void selectMarket(elMarket.value));
elRow.addEventListener("change", () => {
  if (!market) return;
  ui.rowByMarket[rowKey(market)] = Number(elRow.value);
  saveUi();
  schedule();
});
elSession.addEventListener("change", () => {
  if (!market) return;
  ui.sessionByMarket[market.market_id] = elSession.value as SessionMode;
  saveUi();
  schedule();
});
const bindCheck = (el: HTMLInputElement, key: "markers" | "divergence" | "estDelta") => {
  el.checked = ui[key];
  el.addEventListener("change", () => {
    ui[key] = el.checked;
    saveUi();
    schedule();
  });
};
bindCheck(elMarkers, "markers");
bindCheck(elDiv, "divergence");
bindCheck(elEst, "estDelta");
elImb.value = String(ui.imb);
elImb.addEventListener("change", () => {
  ui.imb = Number(elImb.value);
  model.settings.imbRatio = ui.imb;
  model.invalidateBarInfo();
  saveUi();
  schedule();
});
elVa.value = String(ui.va);
elVa.addEventListener("change", () => {
  ui.va = Number(elVa.value);
  saveUi();
  schedule();
});
const elLower = $<HTMLSelectElement>("optLower");
elLower.value = ui.lower;
elLower.addEventListener("change", () => {
  ui.lower = elLower.value as "cvd" | "oi";
  saveUi();
  schedule();
});

const elRecorder = $<HTMLInputElement>("optRecorder");
elRecorder.value = ui.recorderUrl;
elRecorder.addEventListener("change", () => {
  ui.recorderUrl = elRecorder.value.trim();
  recorderNote = null;
  saveUi();
  // the recorder is only read while a feed starts, so reload this market
  if (market) void selectMarket(market.market_id);
});

elTz.value = ui.tz;
elTz.addEventListener("change", () => {
  ui.tz = elTz.value as TimeZoneMode;
  saveUi();
  schedule();
});
$("theme").addEventListener("click", () => {
  ui.theme = ui.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = ui.theme;
  saveUi();
  chart.refreshTheme();
});
$("panelToggle").addEventListener("click", () => {
  panelOpen = !panelOpen;
  document.body.classList.toggle("panel-hidden", !panelOpen);
  // only the standalone app owns this preference
  if (!embed.embed) {
    ui.panel = panelOpen;
    saveUi();
  }
  renderPanel();
});
document.addEventListener("click", (e) => {
  const d = $<HTMLDetailsElement>("opts");
  if (d.open && !d.contains(e.target as Node)) d.open = false;
});
window.addEventListener("hashchange", () => {
  const l = parseLink(location.hash);
  applyLink(l);
  syncControls();
  const id = marketFromToken(markets, l.market);
  // selectMarket() reloads history, which a row/session change also needs
  if ((id && id !== market?.market_id) || pendingLink) void selectMarket(id ?? market?.market_id ?? ui.market);
  else schedule();
});
/** A one-line warning over the chart, used by the in-terminal panel. */
function embedNote(msg: string | null) {
  const el = $<HTMLDivElement>("embedNote");
  el.textContent = msg ?? "";
  el.hidden = !msg;
}

// ---------- account overlay (extension panel only) ----------
// Read-only throughout: this asks the background worker for account data and
// draws lines. Nothing here can place, change or cancel an order.
const elAcctCtrl = $<HTMLDivElement>("acctCtrl");
const elAcct = $<HTMLSelectElement>("acct");
const elAcctStrip = $<HTMLDivElement>("acctStrip");
let accounts: AccountSummary[] = [];
let acctId: string | null = null;
let acctTimer = 0;
let markSource: "MFP mid" | "stream" = "stream";

const money = (n: number | null | undefined) =>
  n == null ? "—" : `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

function untilReset(now: number): string {
  const ms = nextDailyReset(now) - now;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

async function initAccounts() {
  if (!embed.embed || !inExtension()) return;
  // panel.html is generated from index.html, but say so plainly if that ever
  // slips again rather than throwing on a null element
  if (!elAcctCtrl || !elAcct || !elAcctStrip) {
    embedNote("Account UI missing from this build of the panel.");
    return;
  }
  try {
    const st = await keyStatus();
    if (!st.present) return;
    accounts = (await getAccounts()).accounts;
    if (!accounts.length) return;
    elAcct.innerHTML = accounts
      .map((a) => `<option value="${esc(a.id)}">${esc(a.name ?? a.account_number ?? a.id)}${a.stage ? ` · ${esc(a.stage)}` : ""}</option>`)
      .join("");
    acctId = accounts[0].id;
    elAcctCtrl.hidden = false;
    elAcct.onchange = () => {
      acctId = elAcct.value;
      void refreshAccount();
    };
    await refreshAccount();
    // the worker throttles to one refresh per account per 5 s
    acctTimer = window.setInterval(() => void refreshAccount(), 5_000);
  } catch (e) {
    embedNote(`Account data unavailable: ${(e as Error).message}`);
  }
}

async function refreshAccount() {
  if (!acctId || !market) return;
  try {
    const [st, q] = await Promise.all([getAccountState(acctId), getQuote(market.market_id).catch(() => null)]);
    const risk = st.account.risk ?? null;
    const { assetClass } = classifyMarket(market.provider, market.coin);
    // The room is measured against MFP's marks, so the line has to be anchored
    // on MFP's mid, not the venue's last trade — they diverged by 0.07 on SOL,
    // which moved the floor by the same amount. The stream price is only a
    // fallback, and the strip says which one is in use.
    markSource = q?.mid != null ? "MFP mid" : "stream";
    const mark = q?.mid ?? (feed?.lastPrice != null ? feed.lastPrice / PRICE_SCALE : null);
    const ov =
      mark != null && risk
        ? buildOverlay({
            marketId: market.market_id,
            positions: st.positions as unknown as PositionLike[],
            orders: st.orders as unknown as OrderLike[],
            mark,
            dailyRoom: risk.daily_loss_room,
            maxDrawdownRoom: risk.max_drawdown_room,
            assetClass,
            feeExempt: st.policy?.fee_exempt,
            fmt: (n) => formatUnits(Math.round(n * PRICE_SCALE), decimalsFor(feed?.tick || PRICE_SCALE)),
          })
        : null;
    chart.setAccountLines(
      (ov?.lines ?? []).map((l) => ({ price: Math.round(l.price * PRICE_SCALE), kind: l.kind, label: l.label, tone: l.tone })),
    );
    // the plan: no position on this market means no breach line, but the rooms
    // are still worth showing
    renderAcctStrip(st.account, ov?.daily.status ?? "none", ov?.maxDrawdown.status ?? "none", ov?.positions.length ?? 0);
    embedNote(risk ? null : "Account loaded but it carried no risk snapshot — no lines until it does.");
  } catch (e) {
    embedNote(`Account refresh failed: ${(e as Error).message}`);
  }
}

function renderAcctStrip(a: AccountSummary, daily: string, dd: string, onThisMarket: number) {
  const r = a.risk;
  const bits: string[] = [];
  if (!r) {
    elAcctStrip.innerHTML = `<span>No risk snapshot for this account.</span><span class="ro">read-only</span>`;
    elAcctStrip.hidden = false;
    return;
  }
  bits.push(`<span>Equity <b>${money(r.equity)}</b></span>`);
  const part = (label: string, room: number | null, floor: number | null, breached: string) => {
    const share = allowanceShare(room, a.starting_balance, floor);
    const pct = share == null ? "" : ` (${Math.round(share * 100)}% of allowance)`;
    const warn = breached === "already-breached" || (share != null && share < 0.25);
    const text = breached === "already-breached" ? "breached" : `${money(room)}${pct}`;
    bits.push(`<span class="${warn ? "warn" : ""}">${label} <b>${text}</b></span>`);
  };
  part("Daily room", r.daily_loss_room, r.daily_loss_floor, daily);
  part("Max DD room", r.max_drawdown_room, r.max_drawdown_floor, dd);
  bits.push(`<span>Daily reset in <b>${untilReset(Date.now())}</b></span>`);
  // saying so is more useful than an empty chart: it separates "flat here" from
  // "we failed to match your position to this market"
  if (!onThisMarket && market) bits.push(`<span>No position on <b>${esc(marketLabel(market))}</b></span>`);
  else bits.push(`<span>Floors vs <b>${esc(markSource)}</b></span>`);
  bits.push(`<span class="ro">read-only</span>`);
  elAcctStrip.innerHTML = bits.join("");
  elAcctStrip.hidden = false;
}

window.addEventListener("pagehide", () => clearInterval(acctTimer));

// ---------- view explainer ----------
// Shown once per view, the first time it is opened. Storage is best effort:
// a blocked localStorage just means the hint shows again, never a broken app.
const HELP_KEY = "mfp-flow:help-seen:v1";
const elHelpPop = $<HTMLDivElement>("helpPop");

function helpSeen(): Set<string> {
  try {
    const raw = localStorage.getItem(HELP_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {
    /* storage blocked */
  }
  return new Set();
}
function markHelpSeen(v: ViewMode) {
  try {
    const seen = helpSeen();
    seen.add(v);
    localStorage.setItem(HELP_KEY, JSON.stringify([...seen]));
  } catch {
    /* ignore */
  }
}
// A view button opens the hint, and that same click then bubbles to the
// outside-click handler below. Ignore the click that did the opening.
let helpJustOpened = false;
function showHelp(v: ViewMode) {
  const h = HELP[v];
  $("helpTitle").textContent = h.title;
  $("helpList").innerHTML = h.bullets.map((b) => `<li>${esc(b)}</li>`).join("");
  elHelpPop.hidden = false;
  helpJustOpened = true;
  setTimeout(() => {
    helpJustOpened = false;
  }, 0);
}
function hideHelp() {
  elHelpPop.hidden = true;
}
/** First time this view is opened, explain it. */
function helpOnView(v: ViewMode) {
  if (helpSeen().has(v)) return;
  markHelpSeen(v);
  showHelp(v);
}
$("help").addEventListener("click", () => {
  if (elHelpPop.hidden) {
    markHelpSeen(ui.view);
    showHelp(ui.view);
  } else hideHelp();
});
$("helpGot").addEventListener("click", hideHelp);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !elHelpPop.hidden) hideHelp();
});
document.addEventListener("click", (e) => {
  if (elHelpPop.hidden || helpJustOpened) return;
  const t = e.target as Node;
  if (!elHelpPop.contains(t) && t !== $("help") && !$("help").contains(t)) hideHelp();
});

// ---------- share ----------
const elShareNote = $<HTMLParagraphElement>("shareNote");
let noteTimer = 0;
function note(msg: string, tone: "" | "ok" | "bad" = "") {
  elShareNote.textContent = msg;
  if (tone) elShareNote.dataset.tone = tone;
  else delete elShareNote.dataset.tone;
  clearTimeout(noteTimer);
  noteTimer = window.setTimeout(() => {
    elShareNote.textContent = "The link restores this exact view.";
    delete elShareNote.dataset.tone;
  }, 4000);
}

/** The chart at 2x with the attribution footer baked in. */
function buildSnapshot(): { canvas: HTMLCanvasElement; name: string } | null {
  if (!market || !model.bars.length) return null;
  const scale = 2;
  const pal = readPalette();
  const at = new Date();
  const last = model.sessions[model.sessions.length - 1];
  const caption = snapshotCaption({
    market: marketLabel(market),
    view: ui.view,
    tfMin: ui.tf,
    sessionDate: last ? fmtDate(last.start, ui.tz) : "—",
    at,
  });
  const canvas = composeSnapshot({
    chart: chart.snapshot(scale),
    caption,
    scale,
    bg: pal.bg,
    fg: pal.text,
    dim: pal.dim,
    border: pal.grid,
  });
  return { canvas, name: snapshotFilename(market.market_id, ui.view, at) };
}

function toBlob(c: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((res) => c.toBlob(res, "image/png"));
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

$("snapDownload").addEventListener("click", async () => {
  const snap = buildSnapshot();
  if (!snap) return note("Nothing to snapshot yet.", "bad");
  const blob = await toBlob(snap.canvas);
  if (!blob) return note("Couldn't render the image.", "bad");
  saveBlob(blob, snap.name);
  note("Saved.", "ok");
});

$("snapCopy").addEventListener("click", async () => {
  const snap = buildSnapshot();
  if (!snap) return note("Nothing to snapshot yet.", "bad");
  const blob = await toBlob(snap.canvas);
  if (!blob) return note("Couldn't render the image.", "bad");
  // Clipboard images need a secure context and a permissive browser; fall back
  // to a download rather than leaving the click with nothing to show for it.
  try {
    const Item = (window as unknown as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
    if (!Item || !navigator.clipboard?.write) throw new Error("no clipboard image support");
    await navigator.clipboard.write([new Item({ "image/png": blob })]);
    note("Image copied.", "ok");
  } catch {
    saveBlob(blob, snap.name);
    note("Clipboard blocked — downloaded instead.", "ok");
  }
});

$("snapLink").addEventListener("click", async () => {
  syncHash();
  const url = location.href;
  try {
    if (!navigator.clipboard?.writeText) throw new Error("no clipboard");
    await navigator.clipboard.writeText(url);
    note("Link copied.", "ok");
  } catch {
    // last resort: put it somewhere the user can copy by hand
    window.prompt("Copy this link:", url);
  }
});

// The panel runs as an iframe on a third-party page, so treat every message as
// untrusted: only a well-formed market switch from our own content script is
// acted on, and it can only change which market is charted.
window.addEventListener("message", (e) => {
  if (!embed.embed || !isMarketMessage(e.data)) return;
  const m = matchMarket({ symbol: e.data.symbol ?? "", tradfi: e.data.tradfi }, markets);
  embedNote(e.data.symbol && !m ? `No stream market for “${e.data.symbol}” — pick one above.` : null);
  if (m && m.market_id !== market?.market_id) void selectMarket(m.market_id);
});

window.addEventListener("pagehide", () => void feed?.flushPersist());

// ---------- context panel ----------
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function renderPanel() {
  if (!panelOpen) return;
  const f = feed;
  const m = market;
  if (!f || !m) {
    elPanel.innerHTML = `<p class="none">Loading markets…</p>`;
    return;
  }
  const row = model.settings.rowUnits;
  const dp = Math.max(decimalsFor(f.tick || 1), decimalsFor(row));
  const px = (u: number) => formatUnits(u, dp);
  const rowLo = (r: number) => px(r * row);
  const rowHi = (r: number) => px((r + 1) * row);
  const tz = ui.tz;
  const n = model.sessions.length;
  const cur = n ? model.sessions[n - 1] : null;
  const prior = model.ctx.prior;
  const ctx = model.ctx;
  const parts: string[] = [];

  if (marketsNote && markets.length && f.history.state !== "done" && !model.bars.length) parts.push(`<div class="banner">${esc(marketsNote)}</div>`);
  if (recorderNote) parts.push(`<p class="note">Recorder: ${esc(recorderNote)}</p>`);
  if (oiNote) parts.push(`<p class="note">Open interest: ${esc(oiNote)}</p>`);

  // --- session
  parts.push(`<h2>Current session <span class="tag">${esc(sessionModeFor(m) === "ny18" ? "18:00 ET" : "UTC day")}</span></h2>`);
  if (cur?.va) {
    const last = f.lastPrice;
    const loc = last != null ? locationVsValue(last, cur.va, row) : null;
    const rel = prior?.va ? valueRelation(cur.va, prior.va) : null;
    parts.push(`<dl class="kv">
      <dt>Last</dt><dd>${last != null ? px(last) : "—"}${loc ? ` <span class="tag">${loc} value</span>` : ""}</dd>
      <dt class="poc-c">POC</dt><dd class="poc-c">${rowLo(cur.va.poc)}</dd>
      <dt class="va-c">VAH</dt><dd class="va-c">${rowHi(cur.va.vah)}</dd>
      <dt class="va-c">VAL</dt><dd class="va-c">${rowLo(cur.va.val)}</dd>
      <dt>High / Low</dt><dd>${px(cur.high)} / ${px(cur.low)}</dd>
      <dt>Volume</dt><dd>${fmtVol(cur.volume)}</dd>
      <dt>Real Δ</dt><dd class="${cur.realDelta >= 0 ? "buy-c" : "sell-c"}">${fmtSigned(cur.realDelta)}</dd>
      <dt>From live trades</dt><dd>${(cur.realShare * 100).toFixed(1)}%</dd>
      ${rel ? `<dt>Value vs prior</dt><dd>${esc(rel.replace("-", " "))}</dd>` : ""}
    </dl>`);
  } else parts.push(`<p class="none">Waiting for data…</p>`);

  if (prior?.va) {
    parts.push(`<h2>Prior session</h2><dl class="kv">
      <dt class="prior-c">POC</dt><dd class="prior-c">${rowLo(prior.va.poc)}</dd>
      <dt class="prior-c">VAH / VAL</dt><dd class="prior-c">${rowHi(prior.va.vah)} / ${rowLo(prior.va.val)}</dd>
      <dt>High / Low</dt><dd>${px(prior.high)} / ${px(prior.low)}</dd>
    </dl>`);
  }

  // --- TPO structure of the current session
  if (ui.view === "tpo") {
    const t = model.tpo[n - 1];
    parts.push(`<h2>TPO (30m periods)</h2>`);
    if (t?.va) {
      const ibRange = t.ib ? (t.ib.hiRow + 1 - t.ib.loRow) * row : null;
      parts.push(`<dl class="kv">
        <dt class="poc-c">TPO POC</dt><dd class="poc-c">${rowLo(t.va.poc)}</dd>
        <dt class="va-c">TPO VAH / VAL</dt><dd class="va-c">${rowHi(t.va.vah)} / ${rowLo(t.va.val)}</dd>
        ${t.ib ? `<dt>Initial balance</dt><dd>${rowHi(t.ib.hiRow)} / ${rowLo(t.ib.loRow)}</dd><dt>IB range</dt><dd>${px(ibRange!)}</dd>` : ""}
        <dt>Range extension</dt><dd>${t.rangeExtUp && t.rangeExtDown ? "both sides" : t.rangeExtUp ? "up" : t.rangeExtDown ? "down" : "none yet"}</dd>
        <dt>Periods</dt><dd>${t.periods}</dd>
        <dt>Excess</dt><dd>top ${t.topTail >= 2 ? `${t.topTail}-row tail` : t.poorHigh ? '<span class="ctx-c">poor high</span>' : "—"} · bottom ${t.bottomTail >= 2 ? `${t.bottomTail}-row tail` : t.poorLow ? '<span class="ctx-c">poor low</span>' : "—"}</dd>
      </dl>
      <p class="note" style="margin-top:6px">TPO is time at price, rebuilt from 1-minute candle highs and lows, so it's exact for every past session.</p>`);
    } else parts.push(`<p class="none">Waiting for data…</p>`);
  }

  // --- previous sessions
  if (n >= 2) {
    const rowsHtml: string[] = [];
    for (let k = n - 1; k >= 0; k--) {
      const ss = model.sessions[k];
      const va = ui.view === "tpo" ? model.tpo[k]?.va ?? null : ss.va;
      const pv = k > 0 ? (ui.view === "tpo" ? model.tpo[k - 1]?.va ?? null : model.sessions[k - 1].va) : null;
      if (!va) continue;
      const rel = pv ? valueRelation(va, pv).replace("overlapping-", "ovl ") : "—";
      rowsHtml.push(`<tr><td>${esc(fmtDate(ss.start, tz))}${k === n - 1 ? " •" : ""}</td><td class="poc-c">${rowLo(va.poc)}</td><td class="va-c">${rowHi(va.vah)}<br>${rowLo(va.val)}</td><td>${esc(rel)}</td></tr>`);
    }
    parts.push(`<h2>Sessions${ui.view === "tpo" ? " (TPO value)" : ""}</h2><table class="sess"><thead><tr><th>Day</th><th>POC</th><th>VAH / VAL</th><th>Value</th></tr></thead><tbody>${rowsHtml.join("")}</tbody></table>`);
  }
  if (ui.rightProfile === "composite" && model.composite?.va) {
    const c = model.composite;
    parts.push(`<h2>Composite ${c.days}d</h2><dl class="kv">
      <dt class="poc-c">cPOC</dt><dd class="poc-c">${rowLo(c.va!.poc)}</dd>
      <dt class="va-c">cVAH / cVAL</dt><dd class="va-c">${rowHi(c.va!.vah)} / ${rowLo(c.va!.val)}</dd>
      <dt>From live trades</dt><dd>${(c.realShare * 100).toFixed(1)}%</dd>
    </dl>`);
  }

  // --- context (never signals)
  parts.push(`<h2>Auction context</h2>`);
  const items: string[] = [];
  for (const fa of ctx.failed) {
    const up = fa.ref.dir === 1;
    const t = model.bars[fa.backIdx]?.t;
    items.push(`<li><span class="ctx-c">Failed auction ${up ? "above" : "below"} ${esc(fa.ref.label)}</span> ${px(fa.ref.price)}
      <div class="sub">reached ${px(fa.extreme)}, back inside${t ? ` at ${fmtTime(t, tz)}` : ""} · ${fa.deltaQuality === "real" || ui.estDelta ? `excursion Δ ${fmtSigned(fa.excursionDelta)} (${fa.deltaQuality}) · ${fa.supported ? "delta supported the break" : "no delta behind the break"}` : "delta unknown (before recording started)"}</div></li>`);
  }
  for (const p of ctx.poor) {
    items.push(`<li><span class="ctx-c">${p.kind === "poor-high" ? "Poor high" : "Poor low"}</span> ${p.kind === "poor-high" ? rowHi(p.row) : rowLo(p.row)}
      <div class="sub">no excess at the extreme (edge row ${p.rel.toFixed(1)}× mean volume) — often revisited</div></li>`);
  }
  for (const r of ctx.singlePrints.slice(0, 4)) items.push(`<li><span class="ctx-c">Single prints</span> ${rowLo(r.from)} – ${rowHi(r.to)}</li>`);
  for (const r of ctx.lvn.slice(0, 4)) items.push(`<li><span class="ctx-c">Low-volume node</span> ${rowLo(r.from)} – ${rowHi(r.to)}</li>`);
  parts.push(items.length ? `<ul class="list">${items.join("")}</ul>` : `<p class="none">Nothing notable in this session yet.</p>`);

  parts.push(`<h2>Naked POCs</h2>`);
  if (ctx.naked.length) {
    const last = f.lastPrice;
    parts.push(
      `<ul class="list">${ctx.naked
        .map((np) => {
          const p = np.row * row;
          const dist = last != null && last > 0 ? ((p - last) / last) * 100 : null;
          return `<li><span class="naked-c">${rowLo(np.row)}</span>${dist != null ? ` <span class="tag">${dist >= 0 ? "+" : ""}${dist.toFixed(2)}%</span>` : ""}<div class="sub">session of ${fmtDateTime(np.session, tz)}</div></li>`;
        })
        .join("")}</ul>`,
    );
  } else parts.push(`<p class="none">None in the loaded sessions.</p>`);

  // --- data quality
  const real = f.realSince();
  const st = f.stats;
  parts.push(`<h2>Data</h2><dl class="kv">
    <dt>Real delta since</dt><dd>${real ? fmtTime(real, tz) : "—"}</dd>
    <dt>Trades recorded</dt><dd>${f.book ? f.book.accepted.toLocaleString() : 0}</dd>
    <dt>Restored from browser</dt><dd>${f.restoredMinutes} min</dd>
    <dt>Candles</dt><dd>${f.history.candles.toLocaleString()} <span class="tag">${f.history.state}</span></dd>
    ${f.history.coarseBefore ? `<dt>30m history before</dt><dd>${fmtDateTime(f.history.coarseBefore, tz)}</dd>` : ""}
    ${st.markPx != null ? `<dt>Mark</dt><dd>${st.markPx.toFixed(Math.min(8, dp))}</dd>` : ""}
    ${st.openInterestUsd != null ? `<dt>Open interest</dt><dd>${fmtUsd(st.openInterestUsd)}</dd>` : ""}
    ${st.fundingRate != null ? `<dt>Funding</dt><dd>${(st.fundingRate * 100).toFixed(4)}%${st.fundingIntervalHours ? ` / ${st.fundingIntervalHours}h` : ""}</dd>` : ""}
  </dl>`);

  parts.push(`<h2>Legend</h2><div class="legend">
    <span class="sw box" style="background:var(--c-buy)"></span><span>aggressive buys (lift ask), real</span>
    <span class="sw box" style="background:var(--c-sell)"></span><span>aggressive sells (hit bid), real</span>
    <span class="sw hatch"></span><span>estimated from 1m candles (side unknown)</span>
    <span class="sw" style="background:var(--c-poc)"></span><span>POC / developing POC</span>
    <span class="sw" style="background:var(--c-va)"></span><span>value area</span>
    <span class="sw" style="background:var(--c-prior)"></span><span>prior session levels</span>
    <span class="sw" style="background:var(--c-naked)"></span><span>naked POC</span>
  </div>`);

  parts.push(`<p class="note">Footprint and delta are real from the moment this page starts recording (kept in your browser). Older bars are rebuilt from 1-minute candles and shown hatched. Markers describe auction structure — context, not trade signals. Data: MyFundedPerps public market-data stream. Not affiliated with MyFundedPerps.</p>`);
  if (isTradFi(m)) parts.push(`<p class="note">TradFi perp: session defaults to the 18:00 ET (CME-style) day.</p>`);
  elPanel.innerHTML = parts.join("");
}

// ---------- boot ----------
async function boot() {
  syncControls();
  elRow.innerHTML = "<option>—</option>";
  elRow.disabled = true;
  renderPanel();
  const list = await loadMarkets();
  markets = list.markets;
  marketsNote = list.note;
  const featured = markets.filter((x) => ["binance|BTCUSDT", "binance|ETHUSDT", "hyperliquid|xyz:XYZ100", "hyperliquid|xyz:GOLD", "hyperliquid|xyz:SP500", "binance|SOLUSDT"].includes(x.market_id));
  const tradfi = markets.filter((x) => isTradFi(x) && !featured.includes(x));
  const crypto = markets.filter((x) => !isTradFi(x) && !featured.includes(x));
  const opt = (x: Market) => `<option value="${esc(x.market_id)}">${esc(marketLabel(x))}${x.provider === "hyperliquid" && !isTradFi(x) ? " · HL" : ""}</option>`;
  elMarket.innerHTML =
    `<optgroup label="Featured">${featured.map(opt).join("")}</optgroup>` +
    `<optgroup label="Indices, metals, stocks & FX">${tradfi.map(opt).join("")}</optgroup>` +
    `<optgroup label="Crypto">${crypto.map(opt).join("")}</optgroup>`;
  const fromHost = embed.embed ? matchMarket({ symbol: embed.symbol ?? "", tradfi: embed.tradfi }, markets) : null;
  await selectMarket(fromHost?.market_id ?? marketFromToken(markets, bootLink.market) ?? ui.market);
  // the terminal may be on something the stream does not carry: say so rather
  // than silently charting whatever was loaded last
  embedNote(embed.embed && embed.symbol && !fromHost ? `No stream market for “${embed.symbol}” — pick one above.` : null);
  void initAccounts();
  helpOnView(ui.view);
}

// periodic repaint so the "now" edge and clocks move even when quiet
setInterval(() => {
  if (feed) schedule();
}, 5_000);

void boot();
