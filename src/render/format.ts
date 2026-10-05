/** Compact volume formatting for dense cells: at most ~4 significant characters. */
export function fmtVol(v: number): string {
  const a = Math.abs(v);
  if (a === 0) return "0";
  const s = v < 0 ? "-" : "";
  if (a >= 1e9) return s + (a / 1e9).toFixed(a >= 1e10 ? 0 : 1) + "B";
  if (a >= 1e6) return s + (a / 1e6).toFixed(a >= 1e7 ? 0 : 1) + "M";
  if (a >= 1e4) return s + (a / 1e3).toFixed(0) + "k";
  if (a >= 1e3) return s + (a / 1e3).toFixed(1) + "k";
  if (a >= 100) return s + a.toFixed(0);
  if (a >= 10) return s + a.toFixed(1);
  if (a >= 1) return s + a.toFixed(2);
  if (a >= 0.01) return s + a.toFixed(3).replace(/^0/, "");
  if (a >= 0.0001) return s + a.toFixed(4).replace(/^0/, "");
  return s + a.toExponential(0);
}

export function fmtSigned(v: number): string {
  if (v === 0) return "0";
  return (v > 0 ? "+" : "") + fmtVol(v);
}

export function fmtUsd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "–";
  const a = Math.abs(v);
  if (a >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return "$" + (v / 1e3).toFixed(1) + "k";
  return "$" + v.toFixed(2);
}

export function fmtPct(v: number | null | undefined, dp = 2): string {
  if (v == null || !Number.isFinite(v)) return "–";
  return (v > 0 ? "+" : "") + v.toFixed(dp) + "%";
}

export type TimeZoneMode = "local" | "UTC" | "America/New_York";

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: TimeZoneMode, kind: "hm" | "dmhm" | "dm"): Intl.DateTimeFormat {
  const k = tz + kind;
  let f = fmtCache.get(k);
  if (!f) {
    const o: Intl.DateTimeFormatOptions = { hourCycle: "h23" };
    if (tz !== "local") o.timeZone = tz;
    if (kind !== "dm") {
      o.hour = "2-digit";
      o.minute = "2-digit";
    }
    if (kind !== "hm") {
      o.day = "2-digit";
      o.month = "short";
    }
    f = new Intl.DateTimeFormat("en-GB", o);
    fmtCache.set(k, f);
  }
  return f;
}

export function fmtTime(t: number, tz: TimeZoneMode): string {
  return dtf(tz, "hm").format(t);
}
export function fmtDateTime(t: number, tz: TimeZoneMode): string {
  return dtf(tz, "dmhm").format(t);
}
export function fmtDate(t: number, tz: TimeZoneMode): string {
  return dtf(tz, "dm").format(t);
}
export function tzLabel(tz: TimeZoneMode): string {
  return tz === "local" ? "local" : tz === "UTC" ? "UTC" : "NY";
}
