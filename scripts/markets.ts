/**
 * npm run markets — refresh the bundled market list from the public REST API.
 * Browsers on other origins can't read /v1/markets (CORS), so the app ships
 * this snapshot and only uses the live list when the browser can reach it.
 */
import { writeFile } from "node:fs/promises";
import { MARKETS_URL } from "../src/data/markets";

const res = await fetch(MARKETS_URL);
if (!res.ok) throw new Error(`GET ${MARKETS_URL} -> HTTP ${res.status}`);
const body = (await res.json()) as { data: unknown[] };
if (!Array.isArray(body.data) || body.data.length === 0) throw new Error("empty market list");
await writeFile(new URL("../src/data/markets.snapshot.json", import.meta.url), JSON.stringify(body, null, 1) + "\n");
console.log(`saved ${body.data.length} markets`);
