/**
 * Session boundaries.
 *
 *  - "utc":  session = UTC calendar day, [00:00Z, 24:00Z).
 *  - "ny18": CME-style day session starting 18:00 America/New_York, every day
 *            (DST-aware: 22:00Z in summer/EDT, 23:00Z in winter/EST).
 *            Weekends are not merged: HL xyz markets trade 24/7, so each
 *            18:00 ET is a boundary.
 *  - "utcHour": session starts at a configurable UTC hour (0..23).
 */

export type SessionMode = "utc" | "ny18" | "utcHour";

export interface SessionSpec {
  mode: SessionMode;
  /** only for utcHour */
  utcHour?: number;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;

let nyFmt: Intl.DateTimeFormat | null = null;
function nyFormatter(): Intl.DateTimeFormat {
  if (!nyFmt) {
    nyFmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }
  return nyFmt;
}

/** Offset of America/New_York from UTC at instant `t`, in ms (e.g. -4h during EDT). */
export function nyOffsetMs(t: number): number {
  const parts = nyFormatter().formatToParts(new Date(t));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  const tSec = Math.floor(t / 1000) * 1000;
  return asUtc - tSec;
}

/** UTC instant of NY local wall time y-m-d hh:00 (resolves via two offset iterations). */
function nyWallToUtc(y: number, m: number, d: number, hh: number): number {
  const naive = Date.UTC(y, m, d, hh);
  let t = naive - nyOffsetMs(naive);
  t = naive - nyOffsetMs(t);
  return t;
}

/** Start (ms) of the session containing instant t. */
export function sessionStart(t: number, spec: SessionSpec): number {
  switch (spec.mode) {
    case "utc":
      return Math.floor(t / DAY) * DAY;
    case "utcHour": {
      const off = ((spec.utcHour ?? 0) % 24) * HOUR;
      return Math.floor((t - off) / DAY) * DAY + off;
    }
    case "ny18": {
      // NY local date of t
      const local = new Date(t + nyOffsetMs(t));
      const y = local.getUTCFullYear();
      const m = local.getUTCMonth();
      const d = local.getUTCDate();
      const today18 = nyWallToUtc(y, m, d, 18);
      if (t >= today18) return today18;
      const prev = new Date(Date.UTC(y, m, d) - DAY);
      return nyWallToUtc(prev.getUTCFullYear(), prev.getUTCMonth(), prev.getUTCDate(), 18);
    }
  }
}

/** End (exclusive, ms) of the session starting at `start`. */
export function sessionEnd(start: number, spec: SessionSpec): number {
  if (spec.mode !== "ny18") return start + DAY;
  // next 18:00 ET; sessions are 23h/25h on DST switch days
  return sessionStart(start + DAY + 2 * HOUR, spec);
}

/** Start of the session before the one starting at `start`. */
export function prevSessionStart(start: number, spec: SessionSpec): number {
  return sessionStart(start - 1, spec);
}

/** Last `n` session starts ending with the session containing `t` (oldest first). */
export function recentSessionStarts(t: number, spec: SessionSpec, n: number): number[] {
  const out: number[] = [];
  let s = sessionStart(t, spec);
  for (let i = 0; i < n; i++) {
    out.push(s);
    s = prevSessionStart(s, spec);
  }
  return out.reverse();
}

export function sessionLabel(spec: SessionSpec): string {
  switch (spec.mode) {
    case "utc":
      return "UTC day";
    case "ny18":
      return "18:00 ET (CME-style)";
    case "utcHour":
      return `${String(spec.utcHour ?? 0).padStart(2, "0")}:00 UTC`;
  }
}
