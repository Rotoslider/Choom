// Parse a wall-clock date/time that a Choom names in the USER's local timezone
// (e.g. "June 26 at 2:05pm", "2026-06-26 14:05", "tomorrow 9am", "2:05pm") into
// the absolute UTC instant it refers to. This lets a weak model schedule a
// followup by saying the TARGET time directly, instead of doing minutes-from-now
// math and tripping over local-vs-UTC. All interpretation is in `tz`.

// The date/time components of an instant as seen in `tz`.
function getZonedParts(date: Date, tz: string): {
  year: number; month: number; day: number; hour: number; minute: number;
} {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const map: Record<string, number> = {};
  for (const p of dtf.formatToParts(date)) if (p.type !== 'literal') map[p.type] = Number(p.value);
  let hour = map.hour;
  if (hour === 24) hour = 0; // some ICU builds report midnight as 24
  return { year: map.year, month: map.month, day: map.day, hour, minute: map.minute };
}

// The offset (ms) of `tz` at the given UTC instant: (wall-clock-as-UTC) - utc.
// For Mountain summer (MDT = UTC-6) this is -6h.
function tzOffsetMs(tz: string, atUtcMs: number): number {
  const p = getZonedParts(new Date(atUtcMs), tz);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
  return asUTC - atUtcMs;
}

// Convert a wall-clock time IN `tz` to the absolute UTC instant. Two-pass so the
// offset is taken at the actual instant (correct across DST boundaries).
function zonedWallClockToUtc(
  y: number, mo: number, d: number, h: number, mi: number, tz: string,
): Date {
  const naiveUTC = Date.UTC(y, mo - 1, d, h, mi, 0);
  let utc = naiveUTC - tzOffsetMs(tz, naiveUTC);
  utc = naiveUTC - tzOffsetMs(tz, utc); // refine once
  return new Date(utc);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// Parse `input` as a wall-clock date/time in `tz`. Returns the UTC Date, or null
// if no usable time-of-day could be found. A time with no date defaults to today
// (rolling to tomorrow if that time already passed); a date with no year defaults
// to the current year; "today"/"tomorrow" keywords are honored.
export function parseLocalDateTime(input: string, tz: string, now: Date = new Date()): Date | null {
  const s = (input || '').trim().toLowerCase();
  if (!s) return null;

  // Base date = today in tz (or tomorrow if that keyword is present), so month/
  // year rollover is handled by the platform rather than by hand.
  const tomorrow = /\btomorrow\b/.test(s);
  const base = getZonedParts(tomorrow ? new Date(now.getTime() + 86400000) : now, tz);
  let year = base.year, month = base.month, day = base.day;
  let hasExplicitDate = false;

  // --- date ---
  let m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/); // ISO 2026-06-26
  if (m) {
    year = +m[1]; month = +m[2]; day = +m[3]; hasExplicitDate = true;
  } else if ((m = s.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/))) { // US 6/26[/2026]
    month = +m[1]; day = +m[2];
    if (m[3]) year = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    hasExplicitDate = true;
  } else if ((m = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/))) { // June 26[, 2026]
    month = MONTHS.indexOf(m[1]) + 1; day = +m[2];
    if (m[3]) year = +m[3];
    hasExplicitDate = true;
  } else if ((m = s.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:,?\s+(\d{4}))?/))) { // 26 June[, 2026]
    day = +m[1]; month = MONTHS.indexOf(m[2]) + 1;
    if (m[3]) year = +m[3];
    hasExplicitDate = true;
  }

  // --- time of day ---
  let hour = -1, minute = 0;
  let t = s.match(/\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)\b/); // 2:05pm
  if (t) {
    hour = (+t[1] % 12) + (t[3].startsWith('p') ? 12 : 0); minute = +t[2];
  } else if ((t = s.match(/\b(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)\b/))) { // 2pm
    hour = (+t[1] % 12) + (t[2].startsWith('p') ? 12 : 0); minute = 0;
  } else if ((t = s.match(/(?:\bat\s+|t)?(\d{1,2}):(\d{2})\b/))) { // 14:05 / T14:05
    hour = +t[1]; minute = +t[2];
  }

  if (hour < 0 || hour > 23 || minute > 59) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  let dt = zonedWallClockToUtc(year, month, day, hour, minute, tz);

  // Time-only and already past → mean the next occurrence (tomorrow).
  if (!hasExplicitDate && !tomorrow && dt.getTime() <= now.getTime()) {
    const next = getZonedParts(new Date(now.getTime() + 86400000), tz);
    dt = zonedWallClockToUtc(next.year, next.month, next.day, hour, minute, tz);
  }
  return dt;
}
