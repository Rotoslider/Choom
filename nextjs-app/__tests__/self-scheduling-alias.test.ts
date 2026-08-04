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
