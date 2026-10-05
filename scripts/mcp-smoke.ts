/**
 * End-to-end smoke test for the MCP server (Node 22+).
 *
 *   npm run mcp:smoke
 *
 * Spawns the built binary over stdio exactly as an MCP client would, lists the
 * tools, then calls each one against a crypto market and a TradFi perp and
 * prints the result. Live data, so the numbers move; what is being checked is
 * that every tool answers, the shapes are right and the prices parse.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const BIN = new URL("../dist-mcp/mfp-flow-mcp.js", import.meta.url).pathname;
const MARKETS = ["binance|BTCUSDT", "NAS100"];

const transport = new StdioClientTransport({ command: process.execPath, args: [BIN] });
const client = new Client({ name: "mfp-flow-smoke", version: "0.1.0" });
await client.connect(transport);

let failures = 0;
const check = (label: string, cond: boolean, detail = "") => {
  if (!cond) failures++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

const call = async (name: string, args: Record<string, unknown>) => {
  const res = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
  if (res.isError) throw new Error(`${name} returned an error: ${res.content?.[0]?.text}`);
  return JSON.parse(res.content[0].text) as Record<string, any>;
};

const tools = await client.listTools();
console.log(`\ntools: ${tools.tools.map((t) => t.name).join(", ")}`);
check("all four tools registered", ["list_markets", "get_session_profiles", "get_tpo", "get_levels"].every((n) => tools.tools.some((t) => t.name === n)));

console.log("\n## list_markets(query: 'nas')");
const ml = await call("list_markets", { query: "nas" });
console.log(JSON.stringify(ml.markets?.slice(0, 3), null, 2));
check("finds NAS100 by alias", ml.markets?.some((m: any) => m.alias === "NAS100"));

for (const market of MARKETS) {
  console.log(`\n========== ${market} ==========`);

  console.log("\n## get_session_profiles(days: 3)");
  const sp = await call("get_session_profiles", { market, days: 3 });
  console.log(sp.summary);
  console.table(sp.sessions?.map((s: any) => ({ date: s.date, poc: s.poc, vah: s.vah, val: s.val, vol: s.volume, real: s.real_share_pct, vs_prior: s.value_vs_prior })));
  check("returns sessions", (sp.sessions?.length ?? 0) > 0, `${sp.sessions?.length} session(s)`);
  check("prices parse as numbers", sp.sessions.every((s: any) => s.poc === null || Number.isFinite(Number(s.poc))));
  check("carries data_quality", !!sp.data_quality?.tpo);
  check("row size reported", !!sp.row_size);

  console.log("\n## get_tpo(days: 3)");
  const tp = await call("get_tpo", { market, days: 3 });
  console.log(tp.summary);
  console.table(tp.sessions?.map((s: any) => ({ date: s.date, periods: s.periods, poc: s.tpo_poc, vah: s.tpo_vah, val: s.tpo_val, ib: s.initial_balance ? `${s.initial_balance.low}-${s.initial_balance.high}` : "-", ext: s.range_extension, poor: `${s.poor_high ? "H" : ""}${s.poor_low ? "L" : ""}` })));
  check("returns TPO sessions", (tp.sessions?.length ?? 0) > 0, `${tp.sessions?.length} session(s)`);
  check("periods are positive", tp.sessions.every((s: any) => s.periods > 0));
  check("TPO declared exact", /exact/.test(tp.data_quality?.tpo ?? ""));

  console.log("\n## get_levels(days: 5)");
  const lv = await call("get_levels", { market, days: 5 });
  console.log(lv.summary);
  console.log(JSON.stringify({ last: lv.last_price, location: lv.location_vs_value, today: lv.today, prior: lv.prior_session, composite: lv.composite, naked: lv.naked_pocs?.slice(0, 3), failed: lv.failed_auctions, poor: lv.poor_extremes }, null, 2));
  check("has a last price", lv.last_price != null);
  check("naked POC distances are numbers", (lv.naked_pocs ?? []).every((n: any) => n.distance_pct === null || Number.isFinite(n.distance_pct)));
  check("estimated delta is withheld, never guessed", (lv.failed_auctions ?? []).every((f: any) => f.delta_quality === "real" || f.excursion_delta === null));
}

console.log(`\n${failures ? `${failures} CHECK(S) FAILED` : "all checks passed"}`);
await client.close();
process.exit(failures ? 1 : 0);
