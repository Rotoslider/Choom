/**
 * 2026-11-05: Genesis tidied her 14 hourly check-ins. list_self_followups cut every prompt at 90
 * characters, so she could judge none of them (her 2:40 and 3:40 notes looked identical when cut),
 * and changing a note's words meant cancel and schedule again, which is how she cancelled the
 * wrong two. Now the list shows notes whole on request, edit_self_followup rewords one in place,
 * and a cancel names what it cancelled.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { tools } from '@/skills/core/self-scheduling/tools';

// Only Date is faked (see self-followup-recurrence.test.ts): Thu Nov 5 2026, 6:00 AM MST.
const FIXED_NOW = new Date('2026-11-05T13:00:00Z');

const LONG_240 = '2:40 PM check-in. Afternoon. Check the cameras and the house; say something only if it is useful, and ask about the paint drying on the bench.';
const LONG_340 = '3:40 PM check-in. Afternoon. Check the cameras and the house; say something only if it is useful, and look at tomorrow\'s rain before dark.';

describe('follow-ups: whole notes, edit in place, cancel says what it was', () => {
  let tmp: string; let prevCwd: string;
  // QUEUE_ROOT is resolved from cwd at module load, so the handler is imported after chdir.
  beforeAll(() => {
    jest.useFakeTimers({ now: FIXED_NOW, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'] });
    prevCwd = process.cwd(); tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-edit-')); process.chdir(tmp);
  });
  afterAll(() => { jest.useRealTimers(); process.chdir(prevCwd); fs.rmSync(tmp, { recursive: true, force: true }); });

  const ctx = { choomId: 'choom-e', choom: { name: 'Genesis' } } as never;
  const call = (name: string, args: Record<string, unknown>) => ({ id: 'tc', name, arguments: args });
  const parse = (r: { result?: unknown }) => (typeof r.result === 'string' ? JSON.parse(r.result) : r.result) as Record<string, any>;
  const pendingDir = () => path.join(tmp, 'data', 'self_followups', 'choom-e', 'pending');

  let h: { execute: (c: ReturnType<typeof call>, ctx: never) => Promise<{ result?: unknown; error?: string }> };
  let id240 = ''; let id340 = '';

  beforeAll(async () => {
    const { default: Handler } = await import('@/skills/core/self-scheduling/handler');
    h = new Handler() as unknown as typeof h;
    id240 = parse(await h.execute(call('schedule_self_followup', { at: '2:40pm', repeat: 'daily', prompt: LONG_240 }), ctx)).id;
    id340 = parse(await h.execute(call('schedule_self_followup', { at: '3:40pm', repeat: 'daily', prompt: LONG_340 }), ctx)).id;
    expect(id240).toMatch(/^sf_/);
    expect(id340).toMatch(/^sf_/);
  });

  test('the plain list still cuts long prompts, and says how to read them whole', async () => {
    const r = parse(await h.execute(call('list_self_followups', {}), ctx));
    expect(r.followups).toHaveLength(2);
    for (const line of r.followups as string[]) expect(line.endsWith('…')).toBe(true);
    expect(r.cut_short).toMatch(/2 of these prompts/);
    expect(r.cut_short).toContain('list_self_followups with its id');
  });

  test('id shows one note whole; several ids and full=true show them all', async () => {
    const one = parse(await h.execute(call('list_self_followups', { id: id340 }), ctx));
    expect(one.followups).toHaveLength(1);
    expect(one.followups[0]).toContain(LONG_340);
    expect(one.cut_short).toBeUndefined();
    expect(one.pending_count).toBe(2);

    const both = parse(await h.execute(call('list_self_followups', { id: `${id240}, ${id340}` }), ctx));
    expect(both.followups.join('\n')).toContain(LONG_240);
    expect(both.followups.join('\n')).toContain(LONG_340);

    const all = parse(await h.execute(call('list_self_followups', { full: true }), ctx));
    expect(all.followups.join('\n')).toContain(LONG_240);
    expect(all.cut_short).toBeUndefined();
  });

  test('an id that is not pending is named, not silently skipped', async () => {
    const r = parse(await h.execute(call('list_self_followups', { id: 'sf_deadbeef' }), ctx));
    expect(r.followups).toHaveLength(0);
    expect(r.not_pending[0]).toMatch(/sf_deadbeef: no such followup/);
  });

  test('edit rewords in place: same id, same time, same routine, one file', async () => {
    const before = JSON.parse(fs.readFileSync(path.join(pendingDir(), `${id240}.json`), 'utf-8'));
    const NEW = '2:40 PM check-in. Mid-afternoon: battery and solar, the shop, and where Donny is. One useful line or nothing.';
    const r = parse(await h.execute(call('edit_self_followup', { id: id240, prompt: NEW }), ctx));
    expect(r.edited).toBe(true);
    expect(r.id).toBe(id240);
    expect(r.routine).toBe('every day at 2:40 PM');
    const after = JSON.parse(fs.readFileSync(path.join(pendingDir(), `${id240}.json`), 'utf-8'));
    expect(after.prompt).toBe(NEW);
    expect(after.previous_prompt).toBe(LONG_240);
    expect(after.trigger_at).toBe(before.trigger_at);
    expect(after.repeat).toEqual(before.repeat);
    expect(after.series_id).toBe(before.series_id);
    expect(after.written_at).toBe(FIXED_NOW.toISOString());
    expect(after.edited_at).toBe(FIXED_NOW.toISOString());
    expect(fs.readdirSync(pendingDir()).sort()).toEqual([`${id240}.json`, `${id340}.json`].sort()); // nothing left behind
    const listed = parse(await h.execute(call('list_self_followups', { id: id240 }), ctx));
    expect(listed.followups[0]).toContain(NEW);
  });

  test('the same words again change nothing', async () => {
    const cur = JSON.parse(fs.readFileSync(path.join(pendingDir(), `${id240}.json`), 'utf-8'));
    const r = parse(await h.execute(call('edit_self_followup', { id: id240, prompt: cur.prompt }), ctx));
    expect(r.unchanged).toBe(true);
  });

  test('edit needs a real pending id and a prompt', async () => {
    const noPrompt = await h.execute(call('edit_self_followup', { id: id340 }), ctx);
    expect(noPrompt.error).toMatch(/prompt is required/);
    const typed = await h.execute(call('edit_self_followup', { id: 'sf_12345678', prompt: 'x' }), ctx);
    expect(typed.error).toMatch(/copy the id from it/);
  });

  test('cancel says which note it took, with its words, and edit then knows it is gone', async () => {
    const r = parse(await h.execute(call('cancel_self_followup', { id: id340 }), ctx));
    expect(r.cancelled).toBe(true);
    expect(r.was).toContain('every day at 3:40 PM');
    expect(r.prompt).toBe(LONG_340);
    expect(r.message).toContain('3:40 PM');
    const late = await h.execute(call('edit_self_followup', { id: id340, prompt: 'new words' }), ctx);
    expect(late.error).toMatch(/is cancelled, not pending/);
  });

  test('the routine-already-there answer points at edit, not cancel', async () => {
    const r = parse(await h.execute(call('schedule_self_followup', { at: '2:40pm', repeat: 'daily', prompt: 'anything' }), ctx));
    expect(r.already_scheduled).toBe(true);
    expect(r.message).toContain(`edit_self_followup with id ${id240}`);
  });
});

describe('edit_self_followup is offered where cancel is', () => {
  test('defined with id and prompt required, and the list takes id/full', () => {
    const edit = tools.find(t => t.name === 'edit_self_followup');
    expect(edit?.parameters.required).toEqual(['id', 'prompt']);
    const list = tools.find(t => t.name === 'list_self_followups');
    expect(Object.keys(list?.parameters.properties || {})).toEqual(['id', 'full']);
  });

  test('the skill lists it, and delegated workers lose it with the rest', () => {
    const root = path.join(__dirname, '..');
    expect(fs.readFileSync(path.join(root, 'skills/core/self-scheduling/SKILL.md'), 'utf-8')).toContain('  - edit_self_followup');
    expect(fs.readFileSync(path.join(root, 'app/api/chat/route.ts'), 'utf-8')).toContain("stripTools.add('edit_self_followup');");
  });
});
