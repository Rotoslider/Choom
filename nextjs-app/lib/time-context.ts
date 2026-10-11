import type { TimeContext } from './types';

export function getTimeContext(timezone: string = 'America/Denver'): TimeContext {
  const now = new Date();

  // Get localized date/time
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  const parts = formatter.formatToParts(now);
  const getPart = (type: string) =>
    parts.find((p) => p.type === type)?.value || '';

  const hour = parseInt(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    }).format(now)
  );

  // Determine time of day
  let timeOfDay: TimeContext['timeOfDay'];
  if (hour >= 5 && hour < 12) {
    timeOfDay = 'morning';
  } else if (hour >= 12 && hour < 17) {
    timeOfDay = 'afternoon';
  } else if (hour >= 17 && hour < 21) {
    timeOfDay = 'evening';
  } else {
    timeOfDay = 'night';
  }

  // Determine season (Northern Hemisphere)
  const month = now.getMonth();
  let season: TimeContext['season'];
  if (month >= 2 && month <= 4) {
    season = 'spring';
  } else if (month >= 5 && month <= 7) {
    season = 'summer';
  } else if (month >= 8 && month <= 10) {
    season = 'fall';
  } else {
    season = 'winter';
  }

  const dayOfWeek = getPart('weekday');
  const formattedDateTime = formatter.format(now);

  return {
    currentTime: now.toLocaleTimeString('en-US', { timeZone: timezone }),
    currentDate: now.toLocaleDateString('en-US', { timeZone: timezone }),
    dayOfWeek,
    timeOfDay,
    season,
    timezone,
    formattedDateTime,
  };
}

export function formatTimeContextForPrompt(context: TimeContext): string {
  return `Current date and time: ${context.formattedDateTime}
Day: ${context.dayOfWeek}
Time of day: ${context.timeOfDay}
Season: ${context.season}
Timezone: ${context.timezone}`;
}

export function getGreeting(timeOfDay: TimeContext['timeOfDay']): string {
  switch (timeOfDay) {
    case 'morning':
      return 'Good morning';
    case 'afternoon':
      return 'Good afternoon';
    case 'evening':
      return 'Good evening';
    case 'night':
      return 'Hello';
  }
}

export const OWNER_TIMEZONE = 'America/Denver';

/**
 * "Sun, Sep 13, 2:23 PM MDT" — the form a Choom should be handed for ANY
 * timestamp she might repeat to the owner. Tool results that carried
 * `new Date().toISOString()` (UTC) made Eve read a 2:23 PM tower-cam
 * snapshot as "8:23" (2026-09-13).
 */
export function localTimeString(d: Date = new Date(), timezone: string = OWNER_TIMEZONE): string {
  return d.toLocaleString('en-US', {
    timeZone: timezone, weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
}

// A full ISO time that names its zone ("2026-10-11T02:35:00+00:00",
// "…02:35:03.832787+00:00", "…Z"). Times without a zone are left alone.
const ZONED_ISO = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})(?![\d:])/g;

/**
 * Every zoned ISO time in a tool result, in the form localTimeString gives,
 * wherever it sits (a value, an attribute, a list of changes, inside a line
 * of text). Home Assistant reports all of its times in UTC: Genesis read the
 * rain gauge's last rain, "2026-10-11T02:35:00+00:00", as 2:35 when it had
 * rained at 8:35 PM (2026-10-10).
 */
export function localizeTimestamps<T>(value: T, timezone: string = OWNER_TIMEZONE): T {
  if (typeof value === 'string') {
    return value.replace(ZONED_ISO, (iso) => {
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? iso : localTimeString(d, timezone);
    }) as T;
  }
  if (Array.isArray(value)) return value.map((v) => localizeTimestamps(v, timezone)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = localizeTimestamps(v, timezone);
    return out as T;
  }
  return value;
}

/** "2026-09-13_14-23" in the owner's zone, for file names. */
export function localFileStamp(d: Date = new Date(), timezone: string = OWNER_TIMEZONE): string {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).reduce<Record<string, string>>((a, x) => { a[x.type] = x.value; return a; }, {});
  return `${p.year}-${p.month}-${p.day}_${String(Number(p.hour) % 24).padStart(2, '0')}-${p.minute}`;
}
