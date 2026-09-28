/**
 * schedule_self_followup time-parameter alias rescue (C-42).
 *
 * The incident (traces 08-01..08-03): deepseek's nightly heartbeats sent the
 * fire time as `time` instead of `at` on five consecutive turns. Each call ate
 * "Provide either `at` or `delay_minutes`", the model retried identically, and
 * the failure cap then disabled the tool mid-heartbeat — an autonomous
 * scheduling dead-end that recurred every night.
 *
 * A usable value under an obvious wrong name must be accepted, with the real
 * parameter name echoed back so the model can learn it.
 */
import type { ToolCall } from '@/lib/types';
import type { SkillHandlerContext } from '@/lib/skill-handler';

jest.mock('@/lib/db', () => ({ __esModule: true, default: {}, prisma: {} }));

// In-memory queue: capture writes, no filesystem.
const written: Array<{ path: string; entry: Record<string, unknown> }> = [];
jest.mock('@/lib/self-followup-store', () => ({
  QUEUE_ROOT: '/tmp/self-followups-test',
  BUCKETS: ['pending', 'fired', 'cancelled', 'error'],
  bucketDir: (choomId: string, bucket: string) => `/tmp/self-followups-test/${choomId}/${bucket}`,
  entryPath: (choomId: string, bucket: string, id: string) => `/tmp/self-followups-test/${choomId}/${bucket}/${id}.json`,
  atomicWriteJson: (path: string, entry: Record<string, unknown>) => { written.push({ path, entry }); },
  atomicMove: jest.fn(),
  listEntries: () => [],
  migrateLegacyJsonl: jest.fn(),
}));

import SelfSchedulingHandler from '@/skills/core/self-scheduling/handler';

const handler = new SelfSchedulingHandler();
const ctx = {
  choomId: 'choom-test-1',
  choom: { name: 'Genesis' },
  send: jest.fn(),
  settings: {},
} as unknown as SkillHandlerContext;

const call = (args: Record<string, unknown>): ToolCall =>
  ({ id: 't-sched', name: 'schedule_self_followup', arguments: args } as ToolCall);

beforeEach(() => { written.length = 0; });

describe('schedule_self_followup — time under the wrong key', () => {
  test('the exact nightly incident shape ({prompt, reason, time}) now schedules', async () => {
    const res = await handler.execute(call({
      prompt: 'Check on Donny before his dentist appointment and offer quiet support.',
      reason: 'presence',
      time: 'tomorrow 9am',
    }), ctx);
    expect(res.error).toBeUndefined();
    expect(written).toHaveLength(1);
    const r = res.result as { message: string };
    // The real parameter name is echoed so the model learns it.
    expect(JSON.stringify(r)).toContain('`at`');
    expect(new Date(written[0].entry.trigger_at as string).getTime()).toBeGreaterThan(Date.now());
  });

  test.each([['when'], ['at_time'], ['datetime']])('alias `%s` is accepted for at', async (key) => {
    const res = await handler.execute(call({ prompt: 'Quiet check-in later.', [key]: 'tomorrow 9am' }), ctx);
    expect(res.error).toBeUndefined();
    expect(JSON.stringify(res.result)).toContain('not `' + key + '`');
  });

  test.each([['minutes'], ['delay'], ['in_minutes']])('alias `%s` is accepted for delay_minutes', async (key) => {
    const res = await handler.execute(call({ prompt: 'Quiet check-in later.', [key]: 45 }), ctx);
    expect(res.error).toBeUndefined();
    const r = res.result as { delay_minutes: number };
    expect(r.delay_minutes).toBe(45);
    expect(JSON.stringify(res.result)).toContain('delay_minutes');
  });

  test('an unparseable aliased time reports the VALUE, not "nothing provided"', async () => {
    const res = await handler.execute(call({ prompt: 'Later.', time: 'whenever feels right' }), ctx);
    expect(res.error).toContain('Couldn\'t read the time "whenever feels right"');
    expect(written).toHaveLength(0);
  });

  test('genuinely missing time still errors, naming the unreadable keys sent', async () => {
    const res = await handler.execute(call({ prompt: 'Later.', schedule_for: 'x' }), ctx);
    expect(res.error).toContain('Provide either `at`');
    expect(res.error).toContain('`schedule_for`');
    expect(written).toHaveLength(0);
  });

  test('plain {prompt} errors without inventing a default time', async () => {
    const res = await handler.execute(call({ prompt: 'Later.' }), ctx);
    expect(res.error).toContain('Provide either `at`');
    expect(written).toHaveLength(0);
  });

  test('the canonical parameters still work untouched', async () => {
    const res = await handler.execute(call({ prompt: 'Canonical path.', delay_minutes: 30 }), ctx);
    expect(res.error).toBeUndefined();
    expect(JSON.stringify(res.result)).not.toContain('heads-up');
  });
});

describe('schedule_self_followup — time only in the prompt heading (2026-09-28)', () => {
  // DeepSeek wrote the time into the prompt and left out `at` on 45 calls in
  // two weeks; 35 were never retried, so those wake-ups were lost.
  test('the incident shape schedules at the heading time and says so', async () => {
    const res = await handler.execute(call({
      prompt: 'Tomorrow 7:30 AM, morning check: house status, weather, inbox. Then create 5 more self-followups.',
      reason: 'morning presence',
    }), ctx);
    expect(res.error).toBeUndefined();
    expect(written).toHaveLength(1);
    const at = new Date(written[0].entry.trigger_at as string);
    const local = at.toLocaleString('en-US', { timeZone: 'America/Denver', hour: 'numeric', minute: '2-digit' });
    expect(local).toBe('7:30 AM');
    expect(JSON.stringify(res.result)).toContain("read the time from your prompt's heading");
  });

  test('a time later in the task, not the heading, is not a schedule', async () => {
    const res = await handler.execute(call({
      prompt: 'Evening check: ask Donny whether the 3 PM huddle ran long.',
    }), ctx);
    expect(res.error).toContain('Provide either `at`');
    expect(written).toHaveLength(0);
  });

  test('a heading with no clock time still errors', async () => {
    const res = await handler.execute(call({ prompt: 'Sunday morning check-in routine: warm greeting for Donny.', repeat: 'daily' }), ctx);
    expect(res.error).toContain('Provide either `at`');
    expect(written).toHaveLength(0);
  });
});

describe('parseLocalDateTime — named weekdays (2026-09-28)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { parseLocalDateTime, timeFromPromptHeading } = require('@/lib/local-time-parse') as typeof import('@/lib/local-time-parse');
  const TZ = 'America/Denver';
  const MON_11AM = new Date('2026-09-28T17:00:00Z'); // Monday 11:00 AM MDT
  const local = (d: Date | null) => d && d.toLocaleString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  test('"Saturday 9am" on a Monday is this Saturday, not tomorrow', () => {
    expect(local(parseLocalDateTime('Saturday 9am', TZ, MON_11AM))).toBe('Sat, Oct 3, 9:00 AM');
  });
  test('today\'s weekday: later today if still ahead, next week if passed', () => {
    expect(local(parseLocalDateTime('2:00pm Monday', TZ, MON_11AM))).toBe('Mon, Sep 28, 2:00 PM');
    expect(local(parseLocalDateTime('Monday 9am', TZ, MON_11AM))).toBe('Mon, Oct 5, 9:00 AM');
  });
  test('an explicit date wins over the weekday; abbreviations are ordinary words', () => {
    expect(local(parseLocalDateTime('Wed Sep 30 8am', TZ, MON_11AM))).toBe('Wed, Sep 30, 8:00 AM');
    expect(local(parseLocalDateTime('sat 9am', TZ, MON_11AM))).toBe('Tue, Sep 29, 9:00 AM');
  });
  test('headings from the real failures', () => {
    const WED_1046PM = new Date('2026-09-24T04:46:00Z');
    expect(local(timeFromPromptHeading('Thursday 6:30 AM, departure day: final pre-trip check', TZ, WED_1046PM))).toBe('Thu, Sep 24, 6:30 AM');
    expect(local(timeFromPromptHeading('Late-night quiet check (~12:30 AM Thu Sep 24): Donny is asleep.', TZ, WED_1046PM))).toBe('Thu, Sep 24, 12:30 AM');
    expect(timeFromPromptHeading('Weekend Ark check-in: watch at 8 PM', TZ, WED_1046PM)).toBeNull();
  });
});
