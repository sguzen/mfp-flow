/**
 * Per-view explainers, shown once the first time a view is opened.
 *
 * Kept as data, away from the DOM, so `tests/help.test.ts` can hold the copy to
 * the project's rules: these describe auction structure and must never read as
 * a trade recommendation.
 */
import type { ViewMode } from "./model";

export interface Help {
  title: string;
  bullets: string[];
}

export const HELP: Record<ViewMode, Help> = {
  footprint: {
    title: "Reading the footprint",
    bullets: [
      "Every row is one price inside the bar: aggressive sells (hit the bid) on the left, aggressive buys (lifted the ask) on the right.",
      "A boxed cell is a diagonal imbalance — one side is several times the other against the price diagonally opposite it.",
      "Hatched cells are rebuilt from 1-minute candles. The volume is real; the buy/sell split is not known, so it is not claimed.",
      "Δ reads “n/a” for bars older than this page's recording. Aggressor side only arrives on the live stream, never from candles.",
      "The outlined row is that bar's heaviest price, and the strip underneath is per-bar delta and session CVD.",
    ],
  },
  profiles: {
    title: "Reading the profiles",
    bullets: [
      "Each day's volume profile is drawn inside that day's own time span, so you can see where the auction spent its time.",
      "POC is the heaviest price. The value area covers 70% of the day's volume, from VAL up to VAH.",
      "A naked POC is an earlier day's POC that price has not traded back through since.",
      "The right-hand profile is either the newest session on screen or a composite of the last N days — the picker beside “Right”.",
      "Hatching means that volume came from candles rather than recorded trades; the “real %” in the panel tells you how much is exact.",
    ],
  },
  tpo: {
    title: "Reading the TPO",
    bullets: [
      "One letter is one 30-minute period. A is the session's first half hour, then B, C, and on through a–x for a long session.",
      "Letters stack to the right, so a wide row means price kept returning there across many periods.",
      "The bracket beside each session marks its initial balance: the range of that session's first hour.",
      "A row only one letter wide is a single print — the auction moved through that price and did not come back.",
      "A poor high or low is a flat extreme, several periods ending at the same price, rather than a clean tail.",
      "TPO is time at price, rebuilt from 1-minute highs and lows, so unlike the volume split it is exact for every past session.",
    ],
  },
};

/** The standing line: these views describe structure, they do not advise. */
export const DISCLAIMER = "Context, not signals.";
