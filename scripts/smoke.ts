/**
 * End-to-end smoke test against the live MFP market-data stream (Node 22+).
 *
 *   npm run smoke            # 20 s, BTCUSDT (binance) + xyz:XYZ100 (hyperliquid)
 *   npm run smoke -- 60      # 60 s
 *
 * Connects, runs the exact MarketFeed used by the web app, then feeds the
 * result through the analytics and prints trade counts, dedupe stats,
 * real-vs-candle volume reconciliation, POC / VAH / VAL.
 */
import { MINUTE, minuteOf } from "../src/analytics/footprint";
import { decimalsFor, formatUnits } from "../src/analytics/price";
import { pocRow, profileFromRows, valueArea, type RowAccum } from "../src/analytics/profile";
import { buildBars, buildSessions, cvdSeries, minuteKeys } from "../src/analytics/series";
import { sessionLabel, type SessionSpec } from "../src/analytics/session";
import { MarketFeed } from "../src/data/feed";
import type { Market } from "../src/data/markets";
import { MarketStream } from "../src/data/stream";

const secs = Number(process.argv[2] ?? 20);
const markets: Array<{ m: Market; session: SessionSpec }> = [
  { m: { market_id: "binance|BTCUSDT", provider: "binance", symbol: "BTC", coin: "BTCUSDT", size_decimals: 3 }, session: { mode: "utc" } },
  { m: { market_id: "hyperliquid|xyz:XYZ100", provider: "hyperliquid", symbol: "XYZ100", coin: "xyz:XYZ100", size_decimals: 4 }, session: { mode: "ny18" } },
];

const stream = new MarketStream({ log: (...a) => console.log("[stream]", ...a) });
stream.connect();
const t0 = Date.now();
const feeds = markets.map(({ m, session }) => {
  const f = new MarketFeed(stream, m, { priorSessions: 1, session, log: (...a) => console.log(...a) });
  return { f, session };
});
const starts = feeds.map(({ f }) => f.start().catch((e) => console.error(f.market.coin, "start failed", e)));

await new Promise((r) => setTimeout(r, secs * 1000));
console.log(`\n=== after ${((Date.now() - t0) / 1000).toFixed(1)} s (stream rtt ${stream.status.rttMs} ms, clock skew ${stream.status.clockSkewMs} ms) ===`);

for (const { f, session } of feeds) {
  const m = f.market;
  const book = f.book;
  console.log(`\n## ${m.provider} ${m.coin}`);
  if (!book) {
    console.log("  no book (no candles and no trades?)", f.history);
    continue;
  }
  const row = f.buckets!.defaultUnits;
  const dp = decimalsFor(f.tick);
  const fmt = (u: number) => formatUnits(u, Math.max(dp, decimalsFor(row)));
  console.log(`  tick ${fmt(f.tick)}  fine row ${formatUnits(book.fine, decimalsFor(book.fine))}  default row ${fmt(row)}  options [${f.buckets!.options.map((o) => formatUnits(o, decimalsFor(o))).join(", ")}]`);
  console.log(`  trades received ${f.tradesSeen} (replayed on subscribe ${f.tradesReplayed}), unique ${book.accepted}, duplicates dropped ${book.dupes}`);
  const seg = f.coverage.segments.map((s) => `${new Date(s.from).toISOString().slice(11, 19)}→${s.open ? "now" : new Date(s.to).toISOString().slice(11, 19)}`);
  console.log(`  real-trade coverage: ${seg.join(", ")}`);
  console.log(`  1m candles loaded ${f.candles.size} (${f.history.pages} page(s), ${f.history.state}${f.history.message ? ": " + f.history.message : ""}), earliest ${f.history.earliest ? new Date(f.history.earliest).toISOString() : "-"}`);

  // live-only profile (real trades)
  const rows = new Map<number, RowAccum>();
  let buy = 0;
  let sell = 0;
  for (const fp of book.minutes.values()) {
    buy += fp.buy;
    sell += fp.sell;
    for (const [k, [b, s]] of fp.cells) {
      const r = Math.floor(k / (row / book.fine));
      const a = rows.get(r) ?? { b: 0, s: 0, e: 0 };
      a.b += b;
      a.s += s;
      rows.set(r, a);
    }
  }
  const lp = profileFromRows(rows);
  const lva = valueArea(lp);
  console.log(`  LIVE trades profile: vol ${(buy + sell).toFixed(4)} (buy ${buy.toFixed(4)} / sell ${sell.toFixed(4)}, delta ${(buy - sell).toFixed(4)}), rows ${lp.hi - lp.lo + 1}`);
  if (lva) console.log(`     POC ${fmt(pocRow(lp)! * row)}  VAH ${fmt((lva.vah + 1) * row)}  VAL ${fmt(lva.val * row)}  (VA holds ${(lva.pct * 100).toFixed(1)}%)`);

  // reconcile: real minutes vs the provider's 1m candle volume
  const recon: string[] = [];
  for (const [t, fp] of [...book.minutes].sort((a, b) => a[0] - b[0])) {
    const c = f.candles.get(t);
    if (!c) continue;
    const real = f.coverage.isMinuteReal(t);
    recon.push(`${new Date(t).toISOString().slice(11, 16)} trades ${(fp.buy + fp.sell).toFixed(4)} vs candle ${c.v.toFixed(4)}${real ? " (full minute)" : " (partial)"}`);
  }
  if (recon.length) console.log("  trade-vs-candle volume:\n    " + recon.slice(-4).join("\n    "));

  // full pipeline: session bars (estimated + real) → profile / VA / dPOC / CVD
  const src = f.source()!;
  const keys = minuteKeys(src);
  for (const iv of [1, 5, 30]) {
    const bars = buildBars(src, keys, iv * MINUTE, row, session);
    const sess = buildSessions(bars);
    const cur = sess[sess.length - 1];
    if (!cur) continue;
    const cvd = cvdSeries(bars, false);
    if (iv === 5) {
      for (const s of sess) {
        const va = s.va;
        console.log(
          `  ${iv}m session ${new Date(s.start).toISOString().slice(0, 16)}Z (${sessionLabel(session)}): ${s.i1 - s.i0 + 1} bars, vol ${s.volume.toFixed(2)} (${(s.realShare * 100).toFixed(2)}% real), ` +
            (va ? `POC ${fmt(va.poc * row)} VAH ${fmt((va.vah + 1) * row)} VAL ${fmt(va.val * row)}, ` : "") +
            `H ${fmt(s.high)} L ${fmt(s.low)}, dPOC last ${s.dpoc.at(-1) != null ? fmt(s.dpoc.at(-1)! * row) : "-"}, real CVD ${cvd[s.i1].toFixed(4)}`,
        );
      }
    } else {
      console.log(`  ${iv}m bars: ${bars.length}, current session bars ${cur.i1 - cur.i0 + 1}, last bar ${new Date(bars.at(-1)!.t).toISOString().slice(11, 16)} real ${bars.at(-1)!.realMinutes}/${bars.at(-1)!.minutes} min`);
    }
  }
  const lastMin = minuteOf(Date.now());
  console.log(`  last price ${f.lastPrice != null ? fmt(f.lastPrice) : "-"}; current minute real? ${f.coverage.isMinuteReal(lastMin)}; markPx ${f.stats.markPx}`);
}

for (const { f } of feeds) f.stop();
stream.close();
await Promise.race([Promise.all(starts), new Promise((r) => setTimeout(r, 500))]);
process.exit(0);
