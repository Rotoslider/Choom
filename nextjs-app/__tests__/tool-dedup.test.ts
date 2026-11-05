/**
 * A read after a change runs fresh (2026-10-26): Genesis cancelled her trip watch, re-listed her
 * followups, and was served the cached list from before the cancel.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { dropStaleReads, dropUndoneChanges, undoesSomething } from '@/lib/tool-dedup';

const key = (name: string, args: object) => `${name}:${JSON.stringify(args).toLowerCase()}`;
const readOnly = new Set(['list_self_followups', 'search_memories']);

describe('dropStaleReads', () => {
  test('a change drops the cached reads and their repeat counts', () => {
    const cancel = key('cancel_self_followup', { id: 'sf_bb519317' });
    const cache = new Map<string, unknown>([
      [key('list_self_followups', {}), { count: 34 }],
      [key('search_memories', { query: 'trip' }), []],
      [cancel, { success: true, remaining: 33 }],
    ]);
    const hits = new Map<string, number>([[key('list_self_followups', {}), 1]]);
    dropStaleReads(readOnly, 'cancel_self_followup', cache, hits);
    expect([...cache.keys()]).toEqual([cancel]); // the same cancel again is still caught
    expect(hits.size).toBe(0);
  });

  test('a read leaves the cache alone', () => {
    const cache = new Map<string, unknown>([[key('list_self_followups', {}), { count: 34 }]]);
    dropStaleReads(readOnly, 'search_memories', cache);
    expect(cache.size).toBe(1);
  });

  test('the loop drops them after each call it caches', () => {
    const loop = readFileSync(path.join(__dirname, '..', 'lib', 'agentic-loop.ts'), 'utf-8');
    expect(loop).toMatch(/import \{ dropStaleReads[^}]*\} from '@\/lib\/tool-dedup';/);
    expect(loop).toMatch(/executedToolCache\.set\(dedupKey, result\.result\);\s*\}\s*(?:\/\/[^\n]*\n\s*)*dropStaleReads\(PARALLEL_SAFE, tc\.name, executedToolCache, dedupHitCounts\);/);
  });
});

/**
 * A change repeated after an undo runs again (2026-11-05): Genesis cancelled her 8:40 and 10:40
 * routines to reword them, sent the same schedule calls again, and the cache answered "already
 * scheduled" from before the cancels.
 */
describe('dropUndoneChanges', () => {
  const skills: Record<string, string> = {
    schedule_self_followup: 'self-scheduling', cancel_self_followup: 'self-scheduling',
    edit_self_followup: 'self-scheduling', list_self_followups: 'self-scheduling',
    remember: 'memory-management', delete_memory: 'memory-management',
    send_notification: 'notifications',
  };
  const familyOf = (t: string) => skills[t];
  const schedule = key('schedule_self_followup', { at: '8:40am', repeat: 'daily', prompt: '8:40 AM check-in' });
  const remember = key('remember', { title: 'x' });
  const notify = key('send_notification', { message: 'hi' });

  test('schedule → cancel → the same schedule is no longer answered from the cache', () => {
    const cancel = key('cancel_self_followup', { id: 'sf_c81618d5' });
    const cache = new Map<string, unknown>([
      [schedule, { already_scheduled: true, id: 'sf_c81618d5' }],
      [remember, { ok: true }],
      [notify, { sent: true }],
      [cancel, { cancelled: true }],
    ]);
    const hits = new Map<string, number>([[schedule, 1]]);
    dropUndoneChanges(readOnly, 'cancel_self_followup', cancel, familyOf, cache, hits);
    expect(cache.has(schedule)).toBe(false);
    expect(hits.has(schedule)).toBe(false);
    expect(cache.has(cancel)).toBe(true); // the same cancel again is still caught
    expect(cache.has(remember)).toBe(true); // another skill's changes stay
    expect(cache.has(notify)).toBe(true);
  });

  test('a change that undoes nothing leaves earlier changes cached', () => {
    const cache = new Map<string, unknown>([[remember, { ok: true }], [schedule, {}]]);
    const other = key('remember', { title: 'y' });
    dropUndoneChanges(readOnly, 'remember', other, familyOf, cache);
    dropUndoneChanges(readOnly, 'schedule_self_followup', key('schedule_self_followup', { at: '9:40am' }), familyOf, cache);
    expect(cache.size).toBe(2);
  });

  test('an edit counts as an undo; a tool with no skill does nothing', () => {
    const edit = key('edit_self_followup', { id: 'sf_a', prompt: 'new' });
    const cache = new Map<string, unknown>([[schedule, {}], [edit, {}]]);
    dropUndoneChanges(readOnly, 'edit_self_followup', edit, familyOf, cache);
    expect([...cache.keys()]).toEqual([edit]);
    const c2 = new Map<string, unknown>([[schedule, {}]]);
    dropUndoneChanges(readOnly, 'delete_widget', key('delete_widget', {}), familyOf, c2);
    expect(c2.size).toBe(1);
  });

  test('which tools count as taking something back', () => {
    for (const t of ['cancel_self_followup', 'edit_self_followup', 'delete_memory', 'update_calendar_event', 'remove_from_task_list', 'delete_habit']) {
      expect(undoesSomething(t)).toBe(true);
    }
    for (const t of ['schedule_self_followup', 'remember', 'send_notification', 'list_self_followups', 'workspace_write_file']) {
      expect(undoesSomething(t)).toBe(false);
    }
  });

  test('the loop runs it after each successful call, by skill', () => {
    const loop = readFileSync(path.join(__dirname, '..', 'lib', 'agentic-loop.ts'), 'utf-8');
    expect(loop).toContain("import { dropStaleReads, dropUndoneChanges } from '@/lib/tool-dedup';");
    expect(loop).toContain('dropUndoneChanges(PARALLEL_SAFE, tc.name, dedupKey, skillOfTool, executedToolCache, dedupHitCounts);');
    expect(loop).toContain('getSkillRegistry().getSkillForTool(tool)?.metadata.name');
  });
});
