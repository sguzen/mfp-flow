#!/usr/bin/env node
/**
 * mfp-flow-mcp — auction structure for any MyFundedPerps market, over stdio.
 *
 * Every number here comes from the same pure analytics the web app renders, so
 * a question asked through an agent and the same settings on the chart agree.
 * Nothing in this server places, modifies or cancels an order; it only reads
 * the public market-data stream, and needs no API key.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { locationVsValue, valueRelation } from "../analytics/auction.js";
import { decimalsFor } from "../analytics/price.js";
import type { SessionMode } from "../analytics/session.js";
import { binanceSymbol, fetchOiHistory } from "../data/binance-oi.js";
import { ALIASES, defaultSession, isTradFi, loadMarkets, marketLabel, type Market } from "../data/markets.js";
import { ChartModel, type ViewMode } from "../model.js";
import { FeedPool } from "./feeds.js";
import {
  dataQuality,
  levelsSummary,
  pxAt,
  relationPhrase,
  rowLo,
  shapeFailed,
  shapeNaked,
  shapeOi,
  shapePoor,
  shapeSessions,
  shapeTpo,
  vaOf,
  type Px,
} from "./shape.js";

const pool = new FeedPool();
let cachedMarkets: Market[] | null = null;

async function markets(): Promise<Market[]> {
  // the REST market list is CORS-locked in a browser but fine from Node; the
  // bundled snapshot is still the fallback if it is unreachable
  cachedMarkets ??= (await loadMarkets()).markets;
  return cachedMarkets;
}

/** Accept "NAS100", "XYZ100", "BTCUSDT" or a full "provider|coin". */
async function resolve(token: string): Promise<Market> {
  const list = await markets();
  const up = token.trim().toUpperCase();
  const aliasCoin = Object.entries(ALIASES).find(([, a]) => a.toUpperCase() === up)?.[0];
  const m =
    list.find((x) => x.market_id.toUpperCase() === up) ??
    (aliasCoin ? list.find((x) => x.coin === aliasCoin) : undefined) ??
    list.find((x) => x.coin.toUpperCase() === up || x.coin.toUpperCase() === `XYZ:${up}`) ??
    list.find((x) => x.symbol.toUpperCase() === up);
  if (!m) throw new Error(`Unknown market "${token}". Call list_markets to see what is available.`);
  return m;
}

/**
 * The row size the web app would pick for this view, unless one is asked for.
 * Profiles and TPO read better coarse, which is why they are not the tick.
 */
function chooseRow(opts: number[], defaultUnits: number, view: ViewMode, want?: number): number {
  if (want != null) {
    const u = Math.round(want * 100_000_000);
    // snap to an offered bucket so the profile stays on a clean grid
    return opts.reduce((best, o) => (Math.abs(o - u) < Math.abs(best - u) ? o : best), opts[0] ?? defaultUnits);
  }
  if (view === "footprint") return defaultUnits;
  return opts.find((o) => o >= defaultUnits * 5) ?? opts[opts.length - 1] ?? defaultUnits;
}

interface Built {
  market: Market;
  model: ChartModel;
  oiHistory: string | null;
  row: number;
  px: Px;
  last: number | null;
  realSince: number | null;
  session: SessionMode;
  realShare: number;
}

async function build(token: string, days: number, view: ViewMode, wantRow?: number, wantSession?: SessionMode): Promise<Built> {
  const market = await resolve(token);
  const session = wantSession ?? (defaultSession(market).mode as SessionMode);
  const feed = await pool.get(market, session, days);
  const src = feed.source();
  if (!src || !feed.buckets) throw new Error(`No data yet for ${marketLabel(market)}. The market may be idle; try again shortly.`);
  const row = chooseRow(feed.buckets.options, feed.buckets.defaultUnits, view, wantRow);
  const model = new ChartModel({
    tfMin: 30,
    rowUnits: row,
    session: { mode: session },
    vaPct: 0.7,
    imbRatio: 3,
    estDelta: false,
    nakedLookback: days,
    divLookback: 20,
    view,
    rightProfile: "composite",
    compositeDays: days,
  });
  // Binance publishes OI history; MFP keeps none and Hyperliquid only exposes a
  // current value, so those markets get live OI only and the response says so.
  const sym = binanceSymbol(market);
  let oiHistory: string | null = null;
  if (sym) {
    const h = await fetchOiHistory(sym, days);
    if (h.history) {
      feed.mergeOi(h.history.points.map((p) => ({ t: p.t, usd: p.usd })));
      oiHistory = `Binance openInterestHist at ${h.history.period}`;
    }
  }
  model.build(src);
  const cur = model.sessions[model.sessions.length - 1];
  return {
    market,
    model,
    oiHistory,
    row,
    px: pxAt(Math.max(decimalsFor(feed.tick || src.tick), 0)),
    last: feed.lastPrice,
    realSince: feed.realSince(),
    session,
    realShare: cur?.realShare ?? 0,
  };
}

const ok = (payload: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] });

const server = new McpServer({ name: "mfp-flow", version: "0.1.0" });

server.registerTool(
  "list_markets",
  {
    description:
      "List MyFundedPerps markets available on the public market-data stream. Optional query matches the symbol, the stream coin or a friendly alias such as NAS100.",
    inputSchema: { query: z.string().optional().describe("case-insensitive substring, e.g. 'nas', 'gold', 'btc'") },
  },
  async ({ query }) => {
    const list = await markets();
    const q = query?.trim().toLowerCase();
    const rows = list
      .filter((m) => !q || m.symbol.toLowerCase().includes(q) || m.coin.toLowerCase().includes(q) || (ALIASES[m.coin] ?? "").toLowerCase().includes(q))
      .map((m) => ({
        market_id: m.market_id,
        symbol: m.symbol,
        alias: ALIASES[m.coin] ?? null,
        provider: m.provider,
        kind: isTradFi(m) ? "tradfi-perp" : "crypto-perp",
        default_session: defaultSession(m).mode,
      }));
    return ok({ count: rows.length, markets: rows.slice(0, 400), summary: `${rows.length} market(s)${q ? ` matching "${q}"` : ""}.` });
  },
);

server.registerTool(
  "get_session_profiles",
  {
    description:
      "Per-session volume profile for a market: POC, value area, high/low, volume, how much of it is real recorded trade data, and how value moved against the prior session.",
    inputSchema: {
      market: z.string().describe("market id, symbol or alias, e.g. 'NAS100' or 'binance|BTCUSDT'"),
      days: z.number().int().min(1).max(10).default(5).describe("sessions of history, including today"),
      row: z.number().positive().optional().describe("row size in price units; snapped to an offered bucket"),
      session: z.enum(["utc", "ny18"]).optional().describe("session boundary; defaults to UTC day for crypto, 18:00 ET for TradFi perps"),
    },
  },
  async ({ market, days, row, session }) => {
    const b = await build(market, days, "profiles", row, session as SessionMode | undefined);
    const sessions = shapeSessions(b.model.sessions, b.row, b.px, b.model.oiSession);
    const cur = sessions[sessions.length - 1];
    return ok({
      market: { id: b.market.market_id, label: marketLabel(b.market), session: b.session },
      row_size: b.px(b.row),
      last_price: b.last != null ? b.px(b.last) : null,
      sessions,
      composite: b.model.composite ? { days: b.model.composite.days, ...vaOf(b.model.composite.va, b.row, b.px) } : null,
      data_quality: dataQuality(b.realShare, b.realSince, { live: b.model.hasOi, history: b.oiHistory }),
      summary: cur
        ? `${marketLabel(b.market)}: ${sessions.length} session(s). Today POC ${cur.poc}, value ${cur.val}-${cur.vah}, ${cur.value_vs_prior ? relationPhrase(cur.value_vs_prior) : "no prior session"}${cur.open_interest ? `, OI ${cur.open_interest.change_pct > 0 ? "+" : ""}${cur.open_interest.change_pct}% (${cur.open_interest.reading})` : ""}. Context, not signals.`
        : "No sessions in range.",
    });
  },
);

server.registerTool(
  "get_tpo",
  {
    description:
      "Market Profile (TPO) per session: TPO POC and value area, initial balance, range extension, single prints, tails and poor highs/lows. TPO is time at price, so it is exact for every past session.",
    inputSchema: {
      market: z.string().describe("market id, symbol or alias"),
      days: z.number().int().min(1).max(10).default(5),
      row: z.number().positive().optional().describe("row size in price units; snapped to an offered bucket"),
      session: z.enum(["utc", "ny18"]).optional(),
    },
  },
  async ({ market, days, row, session }) => {
    const b = await build(market, days, "tpo", row, session as SessionMode | undefined);
    const rows = shapeTpo(b.model.sessions, b.model.tpo, b.row, b.px);
    const cur = rows[rows.length - 1];
    return ok({
      market: { id: b.market.market_id, label: marketLabel(b.market), session: b.session },
      row_size: b.px(b.row),
      period_minutes: 30,
      sessions: rows,
      data_quality: dataQuality(b.realShare, b.realSince),
      summary: cur
        ? `${marketLabel(b.market)} today: ${cur.periods} periods, TPO POC ${cur.tpo_poc}, IB ${cur.initial_balance ? `${cur.initial_balance.low}-${cur.initial_balance.high}` : "n/a"}, range extension ${cur.range_extension}${cur.poor_high ? ", poor high" : ""}${cur.poor_low ? ", poor low" : ""}. Context, not signals.`
        : "No TPO sessions in range.",
    });
  },
);

server.registerTool(
  "get_levels",
  {
    description:
      "The levels that describe where price sits: last price, location against today's value area, prior session POC/VAH/VAL, naked POCs with distance, composite value, poor extremes and today's failed auctions with their delta quality.",
    inputSchema: {
      market: z.string().describe("market id, symbol or alias"),
      days: z.number().int().min(1).max(10).default(5),
      session: z.enum(["utc", "ny18"]).optional(),
    },
  },
  async ({ market, days, session }) => {
    const b = await build(market, days, "profiles", undefined, session as SessionMode | undefined);
    const ss = b.model.sessions;
    const cur = ss[ss.length - 1] ?? null;
    const prior = b.model.ctx.prior;
    const location = cur?.va && b.last != null ? locationVsValue(b.last, { val: rowLo(cur.va.val, b.row), vah: rowLo(cur.va.vah + 1, b.row) }, b.row) : null;
    const relation = cur?.va && prior?.va ? valueRelation(cur.va, prior.va) : null;
    const naked = shapeNaked(b.model.ctx.naked, b.row, b.px, b.last);
    const failed = shapeFailed(b.model.ctx.failed, b.px);
    return ok({
      market: { id: b.market.market_id, label: marketLabel(b.market), session: b.session },
      row_size: b.px(b.row),
      last_price: b.last != null ? b.px(b.last) : null,
      location_vs_value: location,
      today: cur ? { ...vaOf(cur.va, b.row, b.px), high: b.px(cur.high), low: b.px(cur.low) } : null,
      prior_session: prior ? { ...vaOf(prior.va, b.row, b.px), high: b.px(prior.high), low: b.px(prior.low) } : null,
      value_vs_prior: relation,
      composite: b.model.composite ? { days: b.model.composite.days, ...vaOf(b.model.composite.va, b.row, b.px) } : null,
      naked_pocs: naked,
      poor_extremes: shapePoor(b.model.ctx.poor, b.row, b.px),
      failed_auctions: failed,
      open_interest: shapeOi(b.model.oiSession[b.model.oiSession.length - 1] ?? null),
      data_quality: dataQuality(b.realShare, b.realSince, { live: b.model.hasOi, history: b.oiHistory }),
      summary: levelsSummary({
        market: marketLabel(b.market),
        last: b.last != null ? b.px(b.last) : null,
        location,
        relation,
        naked: naked.length,
        failed: failed.length,
      }),
    });
  },
);

const shutdown = () => {
  pool.dispose();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await server.connect(new StdioServerTransport());
