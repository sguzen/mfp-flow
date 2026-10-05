/**
 * Binance forced-liquidation feed (`<symbol>@forceOrder`).
 *
 * Only Binance-provider markets have one. MFP's stream carries no liquidation
 * data at all, and Hyperliquid publishes none, so those markets show nothing
 * rather than something invented.
 *
 * Two honesty constraints come with this feed and are surfaced in the UI:
 *  - Binance samples it to at most one event per symbol per second, so a
 *    cascade is undercounted. It is a sign that liquidations happened, not a
 *    complete tape of them.
 *  - A forced order's side is the side the exchange traded to *close* someone,
 *    so a SELL means a long was liquidated, and a BUY means a short was.
 */
import { parseUnits } from "../analytics/price";

export interface Liquidation {
  /** trade time */
  t: number;
  /** price in integer units (1e-8) */
  price: number;
  /** base-asset quantity */
  qty: number;
  /** qty x price, in quote currency */
  notional: number;
  /** which side was liquidated */
  side: "long" | "short";
}

/** Null for anything that is not a usable forceOrder payload. */
export function parseForceOrder(raw: unknown): Liquidation | null {
  if (!raw || typeof raw !== "object") return null;
  const msg = raw as Record<string, unknown>;
  if (msg.e !== "forceOrder") return null;
  const o = msg.o as Record<string, unknown> | undefined;
  if (!o || typeof o !== "object") return null;
  const side = String(o.S ?? "").toUpperCase();
  if (side !== "BUY" && side !== "SELL") return null;
  // average price is the fill; fall back to the order price
  const priceStr = String(o.ap ?? o.p ?? "");
  const qty = Number(o.z ?? o.q);
  const t = Number(o.T ?? msg.E);
  if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(t)) return null;
  let price: number;
  try {
    price = parseUnits(priceStr);
  } catch {
    return null;
  }
  if (!(price > 0)) return null;
  return {
    t,
    price,
    qty,
    notional: qty * Number(priceStr),
    // the exchange SELLS to close a long, BUYS to close a short
    side: side === "SELL" ? "long" : "short",
  };
}

export const LIQ_CAVEAT = "Binance liquidations (sampled, max 1/s): undercounts cascades";
export const NO_LIQ_FEED = "no public liquidation feed for this venue";

/**
 * Live liquidation feed for one Binance symbol. Reconnects with backoff, keeps
 * a bounded window, and reports its own state so the UI never implies a feed
 * that is not actually connected.
 */
export class LiquidationFeed {
  readonly items: Liquidation[] = [];
  state: "idle" | "connecting" | "open" | "closed" = "idle";
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private symbol: string,
    private opts: { keepMs?: number; onChange?: () => void; url?: string } = {},
  ) {}

  start() {
    this.stopped = false;
    this.open();
  }

  private open() {
    if (this.stopped) return;
    const base = this.opts.url ?? "wss://fstream.binance.com/ws";
    this.state = "connecting";
    try {
      const ws = new WebSocket(`${base}/${this.symbol.toLowerCase()}@forceOrder`);
      this.ws = ws;
      ws.onopen = () => {
        this.state = "open";
        this.attempt = 0;
        this.opts.onChange?.();
      };
      ws.onmessage = (ev) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String((ev as MessageEvent).data));
        } catch {
          return;
        }
        const liq = parseForceOrder(parsed);
        if (!liq) return;
        this.items.push(liq);
        this.prune();
        this.opts.onChange?.();
      };
      ws.onerror = () => {};
      ws.onclose = () => {
        this.state = this.stopped ? "closed" : "connecting";
        this.ws = null;
        this.retry();
      };
    } catch {
      this.retry();
    }
  }

  private retry() {
    if (this.stopped || this.timer) return;
    const wait = Math.min(30_000, 1000 * 2 ** this.attempt++) * (0.5 + Math.random() / 2);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.open();
    }, wait);
  }

  private prune() {
    const keep = this.opts.keepMs ?? 3 * 86_400_000;
    const cut = Date.now() - keep;
    let i = 0;
    while (i < this.items.length && this.items[i].t < cut) i++;
    if (i) this.items.splice(0, i);
  }

  /** Merge stored liquidations, keeping the list sorted and free of duplicates. */
  restore(items: Liquidation[]) {
    const seen = new Set(this.items.map((l) => `${l.t}|${l.price}|${l.qty}`));
    for (const l of items) {
      const k = `${l.t}|${l.price}|${l.qty}`;
      if (seen.has(k)) continue;
      seen.add(k);
      this.items.push(l);
    }
    this.items.sort((a, b) => a.t - b.t);
    this.prune();
  }

  stop() {
    this.stopped = true;
    this.state = "closed";
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      this.ws?.close();
    } catch {
      /* already gone */
    }
    this.ws = null;
  }
}
