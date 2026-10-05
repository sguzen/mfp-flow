/**
 * mfp·flow recorder — a 24/7 trade recorder with a small read-only HTTP API.
 *
 *   npm run recorder                      # markets from MFP_MARKETS or the default pair
 *   MFP_MARKETS="binance|BTCUSDT,hyperliquid|xyz:XYZ100" npm run recorder
 *
 * Why it exists: the trade stream is live-only, so the browser can only show
 * real aggressor delta from the moment you opened the page. A machine that
 * stays on can record continuously, and the app merges those minutes as real
 * instead of falling back to candle estimates.
 *
 * It runs the same MarketFeed the browser runs, with a SQLite store behind the
 * app's own Persistence interface, so there is no second implementation of the
 * footprint, the dedupe or the coverage tracking.
 *
 * Read-only and keyless: it touches the public market-data stream only.
 */
import { createServer } from "node:http";
import { MarketFeed } from "../src/data/feed.js";
import { loadMarkets, type Market } from "../src/data/markets.js";
import { encodeMinute } from "../src/data/recorder-wire.js";
import { MarketStream } from "../src/data/stream.js";
import { RecorderStore, DAY } from "./store.js";

const PORT = Number(process.env.MFP_PORT ?? 8787);
// loopback by default: this is the user's machine, not a public service
const HOST = process.env.MFP_HOST ?? "127.0.0.1";
const DB = process.env.MFP_DB ?? "recorder.db";
const RETENTION_DAYS = Number(process.env.MFP_RETENTION_DAYS ?? 14);
const WANT = (process.env.MFP_MARKETS ?? "binance|BTCUSDT,hyperliquid|xyz:XYZ100").split(",").map((s) => s.trim()).filter(Boolean);
/** the app can only ask for what we keep */
const MAX_RANGE = (RETENTION_DAYS + 1) * DAY;

const store = new RecorderStore(DB, RETENTION_DAYS);
const stream = new MarketStream();
const feeds = new Map<string, MarketFeed>();

async function start() {
  const { markets } = await loadMarkets();
  const chosen: Market[] = [];
  for (const id of WANT) {
    const m = markets.find((x) => x.market_id === id) ?? markets.find((x) => x.symbol.toUpperCase() === id.toUpperCase());
    if (m) chosen.push(m);
    else console.error(`unknown market "${id}" — skipping`);
  }
  if (!chosen.length) {
    console.error("no markets to record; set MFP_MARKETS");
    process.exit(1);
  }

  stream.connect();
  for (const m of chosen) {
    const feed = new MarketFeed(stream, m, {
      // one prior session is enough to anchor the book; the point is live trades
      priorSessions: 1,
      session: { mode: "utc" },
      persist: store,
      log: (...a) => console.log(`[${m.coin}]`, ...a),
    });
    feeds.set(m.market_id, feed);
    feed.start().catch((e) => console.error(`[${m.coin}] start failed:`, (e as Error).message));
  }
  console.log(`recording ${chosen.map((m) => m.market_id).join(", ")} -> ${DB} (${RETENTION_DAYS}d retention)`);

  setInterval(() => {
    const dropped = store.prune();
    if (dropped) console.log(`pruned ${dropped} minute(s) past retention`);
  }, 6 * 3_600_000).unref();
}

const json = (res: import("node:http").ServerResponse, code: number, body: unknown) => {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json",
    // the app is a static page on another origin, and this serves public
    // market data only — nothing here is account-specific or secret
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  });
  res.end(text);
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "*" });
    return res.end();
  }
  if (req.method !== "GET") return json(res, 405, { error: "read-only service" });

  if (url.pathname === "/health") {
    return json(res, 200, {
      ok: true,
      markets: [...feeds.keys()],
      stream: stream.status.state,
      retention_days: RETENTION_DAYS,
      stored: store.stats(),
    });
  }

  if (url.pathname === "/minutes") {
    const market = url.searchParams.get("market") ?? "";
    if (!market) return json(res, 400, { error: "market is required" });
    const now = Date.now();
    const from = Number(url.searchParams.get("from") ?? now - DAY);
    const to = Number(url.searchParams.get("to") ?? now);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return json(res, 400, { error: "bad from/to" });
    // a wide-open range would serialise the whole database on every request
    if (to - from > MAX_RANGE) return json(res, 400, { error: `range too wide; at most ${RETENTION_DAYS + 1} days` });
    const got = store.read(market, from, to);
    return json(res, 200, {
      market,
      fine: got.fine ?? 0,
      minutes: got.minutes.map(encodeMinute),
      segments: got.segments,
    });
  }

  return json(res, 404, { error: "not found" });
});

const shutdown = () => {
  console.log("\nstopping…");
  for (const f of feeds.values()) f.stop();
  server.close();
  setTimeout(() => {
    store.close();
    process.exit(0);
  }, 300);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.on("error", (e: NodeJS.ErrnoException) => {
  // a port clash is the ordinary case here, and a stack trace helps nobody
  if (e.code === "EADDRINUSE") console.error(`port ${PORT} is already in use - set MFP_PORT to another port.`);
  else console.error("http server error:", e.message);
  for (const f of feeds.values()) f.stop();
  process.exit(1);
});

await start();
server.listen(PORT, HOST, () => console.log(`http://${HOST}:${PORT}  (/minutes, /health)`));
