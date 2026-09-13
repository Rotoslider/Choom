/**
 * Recurring self follow-ups (2026-09-12).
 *
 * Until now every wake-up was a one-shot, so a Choom expressing "every Friday
 * evening" had to re-schedule next week's copy by hand on every fire — and did:
 * two real evening wake-ups spent 16 and 26 tool calls scheduling, cancelling
 * and re-listing her own chain (~300k prompt tokens each), with 29-31 pending
 * entries at any time. A routine is now ONE pending entry carrying a `repeat`
 * rule; when it fires, the scheduler re-queues the next occurrence itself.
 *
 * The rule is deliberately small and mirrored in services/signal-bridge/
 * scheduler.py (`_sf_next_occurrence`): daily, weekdays, weekly (on a weekday),
 * monthly (on a day of month), at a wall-clock time in the owner's zone.
 */

export type RepeatRule = 'daily' | 'weekdays' | 'weekly' | 'monthly';
export type Weekday = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';

export interface Repeat {
  rule: RepeatRule;
  /** Wall-clock time "HH:MM" (24h) in `tz`. */
  time: string;
  /** weekly: the weekday. */
  day?: Weekday;
  /** monthly: day of month 1-28 (clamped so every month has it). */
  day_of_month?: number;
  tz: string;
}

export const WEEKDAYS: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const RULES = new Set<string>(['daily', 'weekdays', 'weekly', 'monthly']);

export function parseRule(raw: unknown): RepeatRule | null {
  if (typeof raw !== 'string') return null;
  const r = raw.trim().toLowerCase();
  if (r === 'every day' || r === 'each day') return 'daily';
  if (r === 'every week' || r === 'each week') return 'weekly';
  if (r === 'every month' || r === 'each month') return 'monthly';
  if (r === 'workdays' || r === 'weekday' || r === 'every weekday') return 'weekdays';
  return RULES.has(r) ? (r as RepeatRule) : null;
}

export function parseWeekday(raw: unknown): Weekday | null {
  if (typeof raw !== 'string') return null;
  const d = raw.trim().toLowerCase().slice(0, 3);
  return (WEEKDAYS as string[]).includes(d) ? (d as Weekday) : null;
}

/** Local wall-clock parts of an instant in a zone. */
export function localParts(d: Date, tz: string): { y: number; m: number; d: number; hh: number; mm: number; wd: number } {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(d)) p[part.type] = part.value;
  return {
    y: Number(p.year), m: Number(p.month), d: Number(p.day),
    hh: Number(p.hour) % 24, mm: Number(p.minute),
    wd: WEEKDAYS.indexOf(p.weekday.toLowerCase().slice(0, 3) as Weekday),
  };
}

/**
 * The instant for wall-clock y-m-d hh:mm in `tz`. Resolved by iteration so DST
 * gaps/overlaps land on the nearest real instant (good enough for a wake-up).
 */
export function zonedInstant(y: number, m: number, d: number, hh: number, mm: number, tz: string): Date {
  let guess = new Date(Date.UTC(y, m - 1, d, hh, mm, 0, 0));
  for (let i = 0; i < 3; i++) {
    const lp = localParts(guess, tz);
    const wantMin = ((y * 12 + (m - 1)) * 31 + d) * 1440 + hh * 60 + mm;
    const haveMin = ((lp.y * 12 + (lp.m - 1)) * 31 + lp.d) * 1440 + lp.hh * 60 + lp.mm;
    const diff = wantMin - haveMin;
    if (diff === 0) break;
    guess = new Date(guess.getTime() + diff * 60_000);
  }
  return guess;
}

function addDaysLocal(y: number, m: number, d: number, n: number): { y: number; m: number; d: number } {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** The first occurrence of `repeat` strictly after `after`. */
export function nextOccurrence(repeat: Repeat, after: Date): Date {
  const [hh, mm] = repeat.time.split(':').map(Number);
  const tz = repeat.tz;
  const now = localParts(after, tz);
  const candidateOn = (y: number, m: number, d: number) => zonedInstant(y, m, d, hh, mm, tz);

  if (repeat.rule === 'monthly') {
    const dom = Math.min(28, Math.max(1, repeat.day_of_month ?? now.d));
    let { y, m } = now;
    for (let i = 0; i < 14; i++) {
      const c = candidateOn(y, m, dom);
      if (c.getTime() > after.getTime()) return c;
      m += 1; if (m > 12) { m = 1; y += 1; }
    }
    return candidateOn(y, m, dom);
  }

  let { y, m, d } = now;
  for (let i = 0; i < 16; i++) {
    const c = candidateOn(y, m, d);
    const wd = localParts(c, tz).wd;
    const dayOk =
      repeat.rule === 'daily' ? true :
      repeat.rule === 'weekdays' ? (wd >= 1 && wd <= 5) :
      /* weekly */ WEEKDAYS[wd] === (repeat.day ?? WEEKDAYS[now.wd]);
    if (dayOk && c.getTime() > after.getTime()) return c;
    ({ y, m, d } = addDaysLocal(y, m, d, 1));
  }
  return candidateOn(y, m, d);
}

export function describeRepeat(repeat: Repeat): string {
  const [hh, mm] = repeat.time.split(':').map(Number);
  const h12 = ((hh + 11) % 12) + 1;
  const t = `${h12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
  switch (repeat.rule) {
    case 'daily': return `every day at ${t}`;
    case 'weekdays': return `weekdays at ${t}`;
    case 'weekly': return `every ${repeat.day ? repeat.day[0].toUpperCase() + repeat.day.slice(1) : 'week'} at ${t}`;
    case 'monthly': return `monthly on the ${repeat.day_of_month ?? '?'} at ${t}`;
  }
}

/** Two routines with the same key are the same routine. */
export function seriesKey(repeat: Repeat, target: 'signal' | 'room', roomId?: string): string {
  return [target, roomId || '', repeat.rule, repeat.time, repeat.day || '', repeat.day_of_month || ''].join('|');
}

/** Does `repeat` fire on the local calendar day that `at` falls on? */
export function repeatCoversDay(repeat: Repeat, at: Date): boolean {
  const lp = localParts(at, repeat.tz);
  switch (repeat.rule) {
    case 'daily': return true;
    case 'weekdays': return lp.wd >= 1 && lp.wd <= 5;
    case 'weekly': return WEEKDAYS[lp.wd] === repeat.day;
    case 'monthly': return lp.d === (repeat.day_of_month ?? -1);
  }
}

export interface PendingLike {
  id: string;
  trigger_at: string;
  target?: 'signal' | 'room';
  room_id?: string;
  repeat?: Repeat;
  prompt: string;
}

export const SLOT_WINDOW_MIN = 20;

/**
 * The pending entry that already covers a wanted wake-up, or null: a
 * one-shot within SLOT_WINDOW_MIN of the same target, or a routine whose
 * rule fires that day within the window of its time. This is the collision
 * check she used to do by hand with list_self_followups on every wake
 * (2026-09-12: two "Monday midday check-in" entries at the same minute, and
 * six 7 AM one-shots left standing under a new daily 7 AM routine).
 */
export function findCoveringEntry(pending: PendingLike[], wantAt: Date, target: 'signal' | 'room', roomId?: string): PendingLike | null {
  const win = SLOT_WINDOW_MIN * 60_000;
  const wantMs = wantAt.getTime();
  for (const e of pending) {
    const eTarget = e.target === 'room' ? 'room' : 'signal';
    if (eTarget !== target || (target === 'room' && (e.room_id || '') !== (roomId || ''))) continue;
    if (e.repeat) {
      if (!repeatCoversDay(e.repeat, wantAt)) continue;
      const [hh, mm] = e.repeat.time.split(':').map(Number);
      const lp = localParts(wantAt, e.repeat.tz);
      const routineAt = zonedInstant(lp.y, lp.m, lp.d, hh, mm, e.repeat.tz).getTime();
      if (Math.abs(routineAt - wantMs) <= win) return e;
    } else if (Math.abs(new Date(e.trigger_at).getTime() - wantMs) <= win) {
      return e;
    }
  }
  return null;
}

/** One-shots that a routine makes redundant (same target, its rule fires that day within the window). */
export function oneShotsCoveredByRoutine(pending: PendingLike[], repeat: Repeat, target: 'signal' | 'room', roomId?: string): PendingLike[] {
  const win = SLOT_WINDOW_MIN * 60_000;
  const [hh, mm] = repeat.time.split(':').map(Number);
  return pending.filter(e => {
    if (e.repeat) return false;
    const eTarget = e.target === 'room' ? 'room' : 'signal';
    if (eTarget !== target || (target === 'room' && (e.room_id || '') !== (roomId || ''))) return false;
    const at = new Date(e.trigger_at);
    if (!repeatCoversDay(repeat, at)) return false;
    const lp = localParts(at, repeat.tz);
    const routineAt = zonedInstant(lp.y, lp.m, lp.d, hh, mm, repeat.tz).getTime();
    return Math.abs(routineAt - at.getTime()) <= win;
  });
}
