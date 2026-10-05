import type { Cell } from "./types";

export interface Imbalance {
  row: number;
  side: "buy" | "sell";
  ratio: number;
}

/**
 * Diagonal imbalances (the standard footprint convention):
 *  - buy imbalance at row r:  ask(r) ≥ ratio × bid(r − 1)
 *  - sell imbalance at row r: bid(r) ≥ ratio × ask(r + 1)
 * Here "ask" = aggressor buy volume, "bid" = aggressor sell volume.
 * A zero opposite cell counts as an imbalance only if the cell volume is at
 * least `minVol`. Only real (side-known) volume is considered.
 */
export function diagonalImbalances(cells: Map<number, Cell>, ratio = 3, minVol = 0): Imbalance[] {
  const out: Imbalance[] = [];
  const hit = (v: number, opp: number) => v > 0 && v >= minVol && (opp > 0 ? v >= ratio * opp : minVol > 0);
  for (const [r, c] of cells) {
    const below = cells.get(r - 1)?.s ?? 0;
    if (hit(c.b, below)) out.push({ row: r, side: "buy", ratio: below > 0 ? c.b / below : Infinity });
    const above = cells.get(r + 1)?.b ?? 0;
    if (hit(c.s, above)) out.push({ row: r, side: "sell", ratio: above > 0 ? c.s / above : Infinity });
  }
  return out;
}

/** Stacked imbalances: ≥ `count` consecutive rows with the same-side imbalance. */
export function stackedImbalances(imbs: Imbalance[], count = 3): Array<{ side: "buy" | "sell"; from: number; to: number }> {
  const out: Array<{ side: "buy" | "sell"; from: number; to: number }> = [];
  for (const side of ["buy", "sell"] as const) {
    const rows = imbs.filter((i) => i.side === side).map((i) => i.row).sort((a, b) => a - b);
    let s = 0;
    for (let i = 1; i <= rows.length; i++) {
      if (i === rows.length || rows[i] !== rows[i - 1] + 1) {
        if (i - s >= count) out.push({ side, from: rows[s], to: rows[i - 1] });
        s = i;
      }
    }
  }
  return out;
}
