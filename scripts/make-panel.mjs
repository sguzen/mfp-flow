/**
 * Generate panel.html from index.html.
 *
 * The extension panel is the same document as the web app, in embed mode. It
 * used to be a checked-in copy, which silently went stale the moment index.html
 * gained an element the panel's code looked for — the account controls were
 * added to one and not the other, and the panel threw on a null element at
 * runtime. Generating it removes that whole class of bug.
 */
import { readFileSync, writeFileSync } from "node:fs";

const src = readFileSync("index.html", "utf8");
const out = src.replace(/<title>[^<]*<\/title>/, "<title>mfp·flow — panel</title>");
if (out === src) throw new Error("index.html has no <title> to rewrite; panel.html would be indistinguishable");
writeFileSync("panel.html", out);
console.log(`panel.html generated from index.html (${out.length} bytes)`);
