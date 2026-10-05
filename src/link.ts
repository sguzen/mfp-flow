/**
 * Deep links: parse and serialise the shareable chart state. Pure, no DOM, so
 * the round trip is unit-tested like the analytics core.
 *
 * Full form (what the app writes):
 *   #m=hyperliquid|xyz:XYZ100&v=tpo&tf=30&d=10&r=composite&row=25&s=ny18
 * Legacy form (what older links use, still honoured):
 *   #XYZ100  #BTCUSDT  #binance|BTCUSDT
 *
 * `market` stays the raw token: alias resolution needs the market list, which
 * belongs to the caller, not here. `row` is the human row size (25, 0.5), not
 * the integer price unit, so links stay readable.
 */
import type { SessionMode } from "./analytics/session";
import type { ViewMode } from "./model";

export interface LinkState {
  market?: string;
  view?: ViewMode;
  tf?: number;
  days?: number;
  rightProfile?: "session" | "composite";
  row?: number;
  session?: SessionMode;
}

const VIEWS: ViewMode[] = ["footprint", "profiles", "tpo"];
const TFS = [1, 5, 15, 30];
const DAYS = [3, 5, 10];
const SESSIONS: SessionMode[] = ["utc", "ny18", "utcHour"];

/** A malformed escape must not take the whole link down. */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Plain decimal, never exponent notation — row sizes go as small as 1e-8. */
function numStr(n: number): string {
  return n.toFixed(10).replace(/\.?0+$/, "");
}

/**
 * Read a hash into state. Unknown keys and values outside the allowed sets are
 * dropped rather than throwing: a hand-edited link should degrade to the parts
 * that make sense, not break the app.
 */
export function parseLink(hash: string): LinkState {
  const raw = hash.replace(/^#/, "").trim();
  if (!raw) return {};
  // legacy: a bare market token carries no "="
  if (!raw.includes("=")) return { market: safeDecode(raw) };

  const out: LinkState = {};
  for (const part of raw.split("&")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = safeDecode(part.slice(0, eq));
    const v = safeDecode(part.slice(eq + 1));
    if (!v) continue;
    switch (k) {
      case "m":
        out.market = v;
        break;
      case "v":
        if ((VIEWS as string[]).includes(v)) out.view = v as ViewMode;
        break;
      case "tf": {
        const n = Number(v);
        if (TFS.includes(n)) out.tf = n;
        break;
      }
      case "d": {
        const n = Number(v);
        if (DAYS.includes(n)) out.days = n;
        break;
      }
      case "r":
        if (v === "session" || v === "composite") out.rightProfile = v;
        break;
      case "row": {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) out.row = n;
        break;
      }
      case "s":
        if ((SESSIONS as string[]).includes(v)) out.session = v as SessionMode;
        break;
    }
  }
  return out;
}

/**
 * Write state back to a hash body (no leading "#"). `|` and `:` are left
 * literal so a shared link stays readable; everything else is encoded.
 */
export function serializeLink(s: LinkState): string {
  const enc = (v: string) => encodeURIComponent(v).replace(/%7C/gi, "|").replace(/%3A/gi, ":");
  const parts: string[] = [];
  if (s.market) parts.push(`m=${enc(s.market)}`);
  if (s.view) parts.push(`v=${s.view}`);
  if (s.tf != null) parts.push(`tf=${s.tf}`);
  if (s.days != null) parts.push(`d=${s.days}`);
  if (s.rightProfile) parts.push(`r=${s.rightProfile}`);
  if (s.row != null) parts.push(`row=${numStr(s.row)}`);
  if (s.session) parts.push(`s=${s.session}`);
  return parts.join("&");
}
