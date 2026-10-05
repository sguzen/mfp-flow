// Daily loss resets at midnight America/New_York (DST-aware).

const NY = "America/New_York";

function nyParts(ms: number) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: NY,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, number> = {};
  for (const { type, value } of fmt.formatToParts(new Date(ms))) {
    if (type !== "literal") p[type] = Number(value);
  }
  return p as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** UTC offset of New York at instant `ms`, in minutes (e.g. -240 during EDT). */
function nyOffsetMinutes(ms: number): number {
  const p = nyParts(ms);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

/** The next New York midnight strictly after `now`, as Unix ms. */
export function nextDailyReset(now: number): number {
  const p = nyParts(now);
  // Midnight that starts the next NY calendar day, as a wall-clock time.
  const wallNextMidnight = Date.UTC(p.year, p.month - 1, p.day + 1, 0, 0, 0);
  // Convert wall time to an instant using the offset in force at that moment.
  // Try the offset at `now` first, then correct once for a DST change.
  let guess = wallNextMidnight - nyOffsetMinutes(now) * 60_000;
  guess = wallNextMidnight - nyOffsetMinutes(guess) * 60_000;
  return guess;
}
