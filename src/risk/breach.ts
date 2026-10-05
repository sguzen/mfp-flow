/**
 * Breach lines: the price at which *this market's* move alone would take the
 * account's equity down to a floor, holding every other position at its mark.
 *
 * Derivation (long, size q > 0, mark m, exit commission rate f per fill):
 *   equity(P) = equity_now + q(P - m) - f·q·P      ← the exit fee is paid too
 *   breach when equity(P) = floor, i.e. the fall equals the room:
 *     q(P - m) - f·q·P = -room
 *     qP(1 - f)        = q·m - room
 *     P                = (q·m - room) / (q·(1 - f))
 * and for a short, where the loss is on the way up:
 *     P                = (q·m + room) / (q·(1 + f))
 *
 * Floors are inclusive: touching the line is a breach, not a near miss. Rooms
 * come straight from the account snapshot (`daily_loss_room`,
 * `max_drawdown_room`), so this never re-derives the platform's own numbers.
 *
 * This is a read-only estimate for a chart line. It is not a guarantee: a stop
 * fills at a fresh price rather than its trigger (see `gap.ts`), funding and
 * swap accrue separately, and other positions move too.
 */
import { commissionBps } from "./costs";
import type { AssetClass } from "./types";

export type Side = "long" | "short";

export interface PositionLike {
  side: Side;
  /** base units, positive */
  size: number;
}

/** Net several positions on one market into a single directional size. */
export function netPosition(positions: PositionLike[]): { side: Side; size: number } | null {
  let net = 0;
  for (const p of positions) {
    if (!(p.size > 0)) continue;
    net += p.side === "long" ? p.size : -p.size;
  }
  if (Math.abs(net) < 1e-12) return null; // flat, or hedged out
  return { side: net > 0 ? "long" : "short", size: Math.abs(net) };
}

/** Commission per fill as a fraction of notional. */
export function feeRate(assetClass: AssetClass, feeExempt = false): number {
  return feeExempt ? 0 : commissionBps(assetClass) / 10_000;
}

export interface BreachInput {
  /** equity minus the floor, from the account snapshot */
  room: number | null;
  side: Side;
  /** net size on this market, base units */
  size: number;
  /** current mark for this market */
  mark: number;
  /** commission per fill, as a fraction (0 when fee-exempt) */
  fee: number;
}

export type Breach =
  /** the price at which this market alone reaches the floor */
  | { status: "ok"; price: number }
  /** room is gone already: the floor is at or above current equity */
  | { status: "already-breached" }
  /** a long whose total collapse to zero still would not reach the floor */
  | { status: "unreachable" }
  /** nothing on this market, or no room figure to work from */
  | { status: "none" };

export function breachPrice(i: BreachInput): Breach {
  if (i.room == null || !Number.isFinite(i.room)) return { status: "none" };
  if (!(i.size > 0) || !Number.isFinite(i.mark) || i.mark <= 0) return { status: "none" };
  // inclusive floors: no room left means it is already breached, not "at 0"
  if (i.room <= 0) return { status: "already-breached" };
  const q = i.size;
  const f = i.fee;
  if (i.side === "long") {
    const price = (i.mark * q - i.room) / (q * (1 - f));
    // price cannot go below zero, so a room bigger than the whole position is
    // simply out of this market's reach
    if (!(price > 0)) return { status: "unreachable" };
    return { status: "ok", price };
  }
  const price = (i.mark * q + i.room) / (q * (1 + f));
  return { status: "ok", price };
}

export interface BreachLines {
  daily: Breach;
  maxDrawdown: Breach;
}

/** Both floors for one market, from a netted position. */
export function breachLines(o: {
  positions: PositionLike[];
  mark: number;
  dailyRoom: number | null;
  maxDrawdownRoom: number | null;
  assetClass: AssetClass;
  feeExempt?: boolean;
}): BreachLines {
  const net = netPosition(o.positions);
  if (!net) return { daily: { status: "none" }, maxDrawdown: { status: "none" } };
  const fee = feeRate(o.assetClass, o.feeExempt);
  const base = { side: net.side, size: net.size, mark: o.mark, fee };
  return {
    daily: breachPrice({ ...base, room: o.dailyRoom }),
    maxDrawdown: breachPrice({ ...base, room: o.maxDrawdownRoom }),
  };
}
