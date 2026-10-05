/**
 * Embed parameters for the in-terminal panel.
 *
 * The content script cannot resolve a ticker (it has no market list), so it
 * passes what the terminal URL said and the panel resolves it with
 * `matchMarket`. Kept separate from `src/link.ts` so the shareable link schema
 * stays about charts, not about how the panel was launched.
 */
export interface EmbedParams {
  embed: boolean;
  symbol: string | null;
  tradfi: boolean;
}

export function parseEmbed(hash: string): EmbedParams {
  const raw = hash.replace(/^#/, "");
  const q = new URLSearchParams(raw);
  const sym = q.get("sym");
  return {
    embed: q.get("embed") === "1",
    symbol: sym ? sym.trim().toUpperCase() || null : null,
    tradfi: q.get("tradfi") === "1",
  };
}

export function embedHash(symbol: string | null, tradfi: boolean): string {
  const q = new URLSearchParams({ embed: "1" });
  if (symbol) q.set("sym", symbol);
  if (tradfi) q.set("tradfi", "1");
  return `#${q.toString()}`;
}

/** What the panel accepts from its host page. Nothing else is acted on. */
export interface MarketMessage {
  source: "mfp-flow";
  type: "market";
  symbol: string | null;
  tradfi: boolean;
}

export function isMarketMessage(d: unknown): d is MarketMessage {
  const m = d as MarketMessage | null;
  return !!m && m.source === "mfp-flow" && m.type === "market" && (typeof m.symbol === "string" || m.symbol === null);
}
