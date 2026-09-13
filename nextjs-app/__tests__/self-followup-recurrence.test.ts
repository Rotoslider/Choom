/**
 * 2026-09-12: routines. One pending entry with a repeat rule, re-queued by the
 * bridge after every fire, instead of a hand-maintained ladder of one-shots.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { nextOccurrence, describeRepeat, seriesKey, parseRule, parseWeekday, localParts, type Repeat } from '@/lib/self-followup-recurrence';

const TZ = 'America/Denver';
const local = (d: Date) => { const p = localParts(d, TZ); return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')} ${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')} ${['sun','mon','tue','wed','thu','fri','sat'][p.wd]}`; };

describe('nextOccurrence', () => {
  test('daily: today if the time is still ahead, else tomorrow', () => {
    const r: Repeat = { rule: 'daily', time: '18:00', tz: TZ };
    // 2026-09-12 10:00 MDT = 16:00Z
    expect(local(nextOccurrence(r, new Date('2026-09-12T16:00:00Z')))).toBe('2026-09-12 18:00 sat');
    // 2026-09-12 18:00 MDT exactly → strictly after → tomorrow
    expect(local(nextOccurrence(r, new Date('2026-09-13T00:00:00Z')))).toBe('2026-09-13 18:00 sun');
  });

  test('weekdays skips the weekend', () => {
    const r: Repeat = { rule: 'weekdays', time: '08:30', tz: TZ };
    // Sat 2026-09-12 10:00 MDT → Mon 14th
    expect(local(nextOccurrence(r, new Date('2026-09-12T16:00:00Z')))).toBe('2026-09-14 08:30 mon');
  });

  test('weekly on a weekday, and the wall-clock time survives the DST change', () => {
    const r: Repeat = { rule: 'weekly', time: '18:00', day: 'fri', tz: TZ };
    const first = nextOccurrence(r, new Date('2026-10-28T16:00:00Z')); // Wed Oct 28
    expect(local(first)).toBe('2026-10-30 18:00 fri');                  // MDT (UTC-6)
    const second = nextOccurrence(r, first);                            // across Nov 1 DST end
    expect(local(second)).toBe('2026-11-06 18:00 fri');                 // MST (UTC-7)
    expect(second.getTime() - first.getTime()).toBe(7 * 24 * 3600_000 + 3600_000);
    expect(first.toISOString()).toBe('2026-10-31T00:00:00.000Z');
    expect(second.toISOString()).toBe('2026-11-07T01:00:00.000Z');
  });

  test('monthly rolls to the next month and clamps to 28', () => {
    const r: Repeat = { rule: 'monthly', time: '09:00', day_of_month: 31, tz: TZ };
    expect(local(nextOccurrence(r, new Date('2026-09-12T16:00:00Z')))).toBe('2026-09-28 09:00 mon');
    expect(local(nextOccurrence(r, new Date('2026-12-28T16:00:00Z')))).toBe('2027-01-28 09:00 thu');
  });

  test('parsers and descriptions', () => {
    expect(parseRule('Every day')).toBe('daily');
    expect(parseRule('weekly')).toBe('weekly');
    expect(parseRule('hourly')).toBeNull();
    expect(parseWeekday('Friday')).toBe('fri');
    expect(parseWeekday('x')).toBeNull();
    expect(describeRepeat({ rule: 'weekly', time: '18:00', day: 'fri', tz: TZ })).toBe('every Fri at 6:00 PM');
    expect(describeRepeat({ rule: 'daily', time: '07:05', tz: TZ })).toBe('every day at 7:05 AM');
    expect(seriesKey({ rule: 'weekly', time: '18:00', day: 'fri', tz: TZ }, 'room', 'r1')).toBe('room|r1|weekly|18:00|fri|');
  });
});

describe('self-scheduling handler routines', () => {
  let tmp: string; let prevCwd: string;
  // QUEUE_ROOT is resolved from cwd at module load, so the store is required after chdir.
  beforeAll(() => { prevCwd = process.cwd(); tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-')); process.chdir(tmp); });
  afterAll(() => { process.chdir(prevCwd); fs.rmSync(tmp, { recursive: true, force: true }); });

  const ctx = { choomId: 'choom-1', choom: { name: 'Genesis' } } as never;
  const call = (name: string, args: Record<string, unknown>) => ({ id: 'tc', name, arguments: args });
  const parse = (r: { result?: unknown; error?: string }) => (typeof r.result === 'string' ? JSON.parse(r.result) : r.result) as Record<string, any>;

  test('schedule with repeat writes ONE pending entry carrying the rule; a second call dedupes; list marks it', async () => {
    const { default: Handler } = await import('@/skills/core/self-scheduling/handler');
    const store = await import('@/lib/self-followup-store');
    const h = new Handler();
    const first = await h.execute(call('schedule_self_followup', { at: 'tomorrow 6:00pm', prompt: 'Evening reflection: how did the day go?', repeat: 'daily' }), ctx);
    const r1 = parse(first);
    expect(r1.success).toBe(true);
    expect(r1.routine).toBe('every day at 6:00 PM');
    const pending = store.listEntries('choom-1', 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0].repeat).toEqual({ rule: 'daily', time: '18:00', tz: 'America/Denver' });
    expect(pending[0].series_id).toMatch(/^series_/);
    expect(localParts(new Date(pending[0].trigger_at), TZ).hh).toBe(18);

    const again = await h.execute(call('schedule_self_followup', { at: '6pm', prompt: 'Evening reflection again', repeat: 'daily' }), ctx);
    const r2 = parse(again);
    expect(r2.already_scheduled).toBe(true);
    expect(r2.id).toBe(r1.id);
    expect(store.listEntries('choom-1', 'pending')).toHaveLength(1);

    const weekly = await h.execute(call('schedule_self_followup', { at: '6pm', prompt: 'Friday plans', repeat: 'weekly', day: 'fri' }), ctx);
    expect(parse(weekly).routine).toBe('every Fri at 6:00 PM');
    const oneShot = await h.execute(call('schedule_self_followup', { delay_minutes: 60, prompt: 'check the build' }), ctx);
    expect(parse(oneShot).routine).toBeUndefined();

    const list = parse(await h.execute(call('list_self_followups', {}), ctx));
    expect(list.pending_count).toBe(3);
    expect(list.routine_count).toBe(2);
    expect(list.followups[0]).toContain('↻');
    expect(list.followups[1]).toContain('↻');
    expect(list.followups[2]).not.toContain('↻');
    expect(list.format).toContain('do not schedule their next occurrence by hand');
  });

  test('improvised parameter names still make a routine', async () => {
    const { default: Handler } = await import('@/skills/core/self-scheduling/handler');
    const h = new Handler();
    const r = parse(await h.execute(call('schedule_self_followup', { routine: 'weekly', time: '18:00', day_of_week: 'friday', prompt: 'Friday plans (alias test)' }), ctx));
    expect(r.routine).toBe('every Fri at 6:00 PM');
    const r2 = parse(await h.execute(call('schedule_self_followup', { repeat: 'every saturday', at: '9am', prompt: 'Saturday (alias test)' }), ctx));
    expect(r2.routine).toBe('every Sat at 9:00 AM');
  });

  test('bad repeat args are rejected', async () => {
    const { default: Handler } = await import('@/skills/core/self-scheduling/handler');
    const h = new Handler();
    const bad = await h.execute(call('schedule_self_followup', { at: '6pm', prompt: 'x', repeat: 'hourly' }), ctx);
    expect(bad.error ?? parse(bad).error).toMatch(/repeat must be one of/);
    const noDay = await h.execute(call('schedule_self_followup', { at: '6pm', prompt: 'x', repeat: 'monthly', day: '31' }), ctx);
    expect(noDay.error ?? parse(noDay).error).toMatch(/1-28/);
  });
});
