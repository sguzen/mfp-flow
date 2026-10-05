/**
 * Optional recorder client.
 *
 * If the user points the app at a running recorder, its minutes are merged in
 * as *real* recorded trades before the app falls back to estimating from 1m
 * candles. That is the whole value: real aggressor delta for days you were not
 * watching.
 *
 * The URL is user-supplied, so the response is untrusted (see recorder-wire)
 * and a failure is always silent-but-reported, never fatal: no recorder, or a
 * broken one, must leave the chart exactly as it would have been.
 */
import type { Segment } from "../analytics/footprint";
import type { MinuteFP } from "../analytics/types";
import { decodeMinutes } from "./recorder-wire";

export interface Restored {
  minutes: MinuteFP[];
  segments: Segment[];
}

/**
 * Merge two sets of recorded minutes. Where both have the same minute, keep the
 * one with more trades in it: a partially-recorded minute from a browser that
 * was only open briefly should lose to the server that saw the whole thing.
 */
export function mergeRestored(a: Restored | null, b: Restored | null): Restored | null {
  if (!a) return b;
  if (!b) return a;
  const byT = new Map<number, MinuteFP>();
  for (const m of a.minutes) byT.set(m.t, m);
  for (const m of b.minutes) {
    const have = byT.get(m.t);
    if (!have || m.n > have.n) byT.set(m.t, m);
  }
  return {
    minutes: [...byT.values()].sort((x, y) => x.t - y.t),
    segments: [...a.segments, ...b.segments],
  };
}

export function normaliseBase(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export interface RecorderResult {
  restored: Restored | null;
  /** for the panel: what happened, in one line */
  note: string | null;
}

/**
 * Fetch a window of recorded minutes. Returns nothing rather than throwing;
 * `note` explains why when it comes back empty.
 */
export async function fetchRecorder(
  baseUrl: string,
  marketId: string,
  fine: number,
  since: number,
  timeoutMs = 8000,
): Promise<RecorderResult> {
  const base = normaliseBase(baseUrl);
  if (!base) return { restored: null, note: null };
  const url = `${base}/minutes?market=${encodeURIComponent(marketId)}&from=${Math.floor(since)}&to=${Date.now()}`;
  try {
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = setTimeout(() => ctl?.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctl?.signal, credentials: "omit" });
    clearTimeout(timer);
    if (!res.ok) return { restored: null, note: `Recorder returned HTTP ${res.status}.` };
    const decoded = decodeMinutes(await res.json());
    if (!decoded) return { restored: null, note: "Recorder sent a response this app could not read." };
    if (!decoded.minutes.length) return { restored: null, note: "Recorder has nothing stored for this market yet." };
    // cells are indexed at a row size; merging across different ones would put
    // volume at the wrong prices
    if (decoded.fine !== fine)
      return {
        restored: null,
        note: `Recorder stores this market at a different row size (${decoded.fine} vs ${fine}); not merged.`,
      };
    return {
      restored: { minutes: decoded.minutes, segments: decoded.segments },
      note: `Merged ${decoded.minutes.length} recorded minute(s) as real${decoded.skipped ? `, skipped ${decoded.skipped} bad record(s)` : ""}.`,
    };
  } catch (e) {
    const msg = (e as Error).name === "AbortError" ? "timed out" : (e as Error).message;
    return { restored: null, note: `Recorder unreachable (${msg}).` };
  }
}
