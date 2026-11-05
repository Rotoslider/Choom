/**
 * Nov 4 2026 (Donny's ask): each Choom gets a wake-up model for her own
 * wake-ups, and Simple Tasks only takes a short reminder, habit or calendar
 * ask that Donny typed 1:1.
 */
import { withWakeModel } from '@/lib/wake-model';
import { checkSimpleTask, SIMPLE_TASK_MAX_WORDS } from '@/lib/simple-task-routing';

describe('wake-up model', () => {
  const genesis = { wakeModel: 'deepseek/deepseek-v4.1-flash-1017', wakeProvider: 'openrouter_1' };

  test('her wake-ups use it', () => {
    expect(withWakeModel(undefined, genesis, true)).toEqual({ model: 'deepseek/deepseek-v4.1-flash-1017', provider_id: 'openrouter_1' });
  });

  test('a local wake-up model has no provider', () => {
    expect(withWakeModel(null, { wakeModel: 'google/gemma-4-26b-a4b', wakeProvider: null }, true)).toEqual({ model: 'google/gemma-4-26b-a4b' });
  });

  test("a heartbeat task's own model still wins", () => {
    const task = { model: 'qwen/qwen3.8-27b', provider_id: 'lmstudio_1' };
    expect(withWakeModel(task, genesis, true)).toBe(task);
  });

  test('chats with Donny stay on her primary model', () => {
    expect(withWakeModel(undefined, genesis, false)).toBeUndefined();
  });

  test('no wake-up model set: her primary model, as before', () => {
    expect(withWakeModel(undefined, { wakeModel: null, wakeProvider: null }, true)).toBeUndefined();
    expect(withWakeModel({ model: '' }, { wakeModel: null }, true)).toBeUndefined();
  });
});

describe('Simple Tasks', () => {
  const ask = (intentToolHint: string, message: string, ownerTurn = true) =>
    checkSimpleTask({ intentToolHint, ownerTurn, message }).use;

  test('a quick reminder, habit or calendar ask from Donny', () => {
    expect(ask('create_reminder', 'Remind me to call the vet at 3 tomorrow')).toBe(true);
    expect(ask('get_calendar_events', "what's on my calendar today?")).toBe(true);
    expect(ask('log_habit', 'habit walked 2 miles')).toBe(true);
    expect(ask('habit_stats', 'how often did I walk this month')).toBe(true);
  });

  test('memory, music, weather and task lists stay on her own model', () => {
    for (const hint of ['search_memories', 'remember', 'music_control', 'music_play', 'get_weather', 'add_to_task_list', '']) {
      expect(ask(hint, 'short message')).toBe(false);
    }
  });

  test('rooms, wake-ups, house notes and delegations never switch', () => {
    expect(ask('create_reminder', 'Remind me to call the vet at 3', false)).toBe(false);
  });

  test('a longer message is conversation that mentions a reminder', () => {
    const long = `Remind me to call the vet at 3, and ${'tell me how your day went and what you thought about '.repeat(3)}`;
    expect(long.trim().split(/\s+/).length).toBeGreaterThan(SIMPLE_TASK_MAX_WORDS);
    expect(checkSimpleTask({ intentToolHint: 'create_reminder', ownerTurn: true, message: long })).toEqual({
      use: false, why: expect.stringContaining('more than a quick ask'),
    });
  });

  test('a message with a picture stays on her model', () => {
    expect(ask('create_reminder', '[User attached image: uploads/receipt.png] remind me to pay this Friday')).toBe(false);
  });
});
