/**
 * Turns an account snapshot into the labelled price lines the chart draws for
 * the market on screen: each position's entry, its protective stop and target,
 * its liquidation price, and the two breach lines.
 *
 * Matching exits to positions follows the API: an exit is a *working*,
 * reduce-only stop/take order on the same market, pointing the opposite way to
 * the position. `target_position_id` is used when the API sets it; otherwise
 * market + opposite side + reduce_only is the fallback the plan specifies.
 *
 * Pure: the shapes below are the subset of the API objects this needs, so the
 * whole thing is testable without a network.
 */
import { breachLines, type Breach, type Side } from "./breach";
import type { AssetClass } from "./types";

export interface PositionLike {
  id?: string;
  market_id: string;
  side: Side;
  size: number;
  entry_price: number;
  liquidation_price?: number | null;
}

export interface OrderLike {
  id?: string;
  market_id: string;
  /** buy / sell */
  side: string;
  type: string;
  reduce_only?: boolean;
  trigger_price?: number | null;
  limit_price?: number | null;
  target_position_id?: string | null;
}

export type LineKind = "entry" | "stop" | "target" | "liquidation" | "daily-breach" | "drawdown-breach";

export interface OverlayLine {
  kind: LineKind;
  price: number;
  label: string;
  /** how much of this is measured vs inferred, for the caller's styling */
  tone: "neutral" | "good" | "bad" | "warn";
}

const isStop = (t: string) => t === "stop_market" || t === "stop_limit";
const isTake = (t: string) => t === "take_market" || t === "take_limit" || t === "take_profit";

/** The price an exit order would trigger at. */
export function exitPrice(o: OrderLike): number | null {
  const p = o.trigger_price ?? o.limit_price ?? null;
  return typeof p === "number" && Number.isFinite(p) && p > 0 ? p : null;
}

/**
 * Exits belonging to `pos`. A reduce-only stop/take on the same market pointing
 * against the position; `target_position_id` wins when present, so a hedged
 * market does not hand one position the other's stop.
 */
export function exitsFor(pos: PositionLike, orders: OrderLike[]): { stop: number | null; target: number | null } {
  const wantSide = pos.side === "long" ? "sell" : "buy";
  const tagged = orders.filter((o) => o.target_position_id && pos.id && o.target_position_id === pos.id);
  const pool = tagged.length
    ? tagged
    : orders.filter(
        (o) =>
          o.market_id === pos.market_id &&
          o.reduce_only === true &&
          o.side?.toLowerCase() === wantSide &&
          // an untagged order cannot be attributed on a market holding both ways
          !o.target_position_id,
      );
  let stop: number | null = null;
  let target: number | null = null;
  for (const o of pool) {
    const p = exitPrice(o);
    if (p == null) continue;
    if (isStop(o.type)) stop = stop == null ? p : pos.side === "long" ? Math.max(stop, p) : Math.min(stop, p);
    else if (isTake(o.type)) target = target == null ? p : pos.side === "long" ? Math.min(target, p) : Math.max(target, p);
  }
  return { stop, target };
}

export interface OverlayInput {
  marketId: string;
  positions: PositionLike[];
  orders: OrderLike[];
  mark: number;
  dailyRoom: number | null;
  maxDrawdownRoom: number | null;
  assetClass: AssetClass;
  feeExempt?: boolean;
  fmt?: (n: number) => string;
}

export interface Overlay {
  lines: OverlayLine[];
  daily: Breach;
  maxDrawdown: Breach;
  /** positions on this market, after filtering */
  positions: PositionLike[];
}

export function buildOverlay(i: OverlayInput): Overlay {
  const fmt = i.fmt ?? ((n: number) => String(n));
  const mine = i.positions.filter((p) => p.market_id === i.marketId && p.size > 0);
  const lines: OverlayLine[] = [];

  for (const p of mine) {
    const dir = p.side === "long" ? "Long" : "Short";
    lines.push({ kind: "entry", price: p.entry_price, label: `${dir} entry ${fmt(p.entry_price)}`, tone: "neutral" });
    const { stop, target } = exitsFor(p, i.orders);
    if (stop != null) lines.push({ kind: "stop", price: stop, label: `Stop ${fmt(stop)}`, tone: "bad" });
    if (target != null) lines.push({ kind: "target", price: target, label: `Target ${fmt(target)}`, tone: "good" });
    if (p.liquidation_price && p.liquidation_price > 0)
      lines.push({ kind: "liquidation", price: p.liquidation_price, label: `Liquidation ${fmt(p.liquidation_price)}`, tone: "bad" });
  }

  const b = breachLines({
    positions: mine.map((p) => ({ side: p.side, size: p.size })),
    mark: i.mark,
    dailyRoom: i.dailyRoom,
    maxDrawdownRoom: i.maxDrawdownRoom,
    assetClass: i.assetClass,
    feeExempt: i.feeExempt,
  });
  if (b.daily.status === "ok") lines.push({ kind: "daily-breach", price: b.daily.price, label: `Daily loss floor ${fmt(b.daily.price)}`, tone: "warn" });
  if (b.maxDrawdown.status === "ok")
    lines.push({ kind: "drawdown-breach", price: b.maxDrawdown.price, label: `Max drawdown floor ${fmt(b.maxDrawdown.price)}`, tone: "warn" });

  return { lines, daily: b.daily, maxDrawdown: b.maxDrawdown, positions: mine };
}

/** Room as a share of its limit, for the panel's warning colour. */
export function roomShare(room: number | null, floorDistanceAtStart: number | null): number | null {
  if (room == null || !floorDistanceAtStart || floorDistanceAtStart <= 0) return null;
  return Math.max(0, Math.min(1, room / floorDistanceAtStart));
}
