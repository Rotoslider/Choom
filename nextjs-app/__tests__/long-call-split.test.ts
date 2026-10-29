/**
 * 2026-10-25: Eve (Qwen 3.8 27B) wrote a long file four times, ~2½ minutes
 * each, and every workspace_write_file arrived as {} — answered with "retry
 * with all required parameters", so she sent the same long call again, and
 * after two the tool was blocked for the turn. A lost long call now says to
 * split it, and workspace_write_file can append.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let root: string;
jest.mock('@/lib/db', () => ({ __esModule: true, default: {}, prisma: {} }));
jest.mock('@/lib/config', () => ({ ...jest.requireActual('@/lib/config'), get WORKSPACE_ROOT() { return root; } }));

import { emptyArgsError, LONG_CALL_TOKENS } from '@/lib/tool-arg-repair';
import WorkspaceFilesHandler from '@/skills/core/workspace-files/handler';

describe('emptyArgsError', () => {
  test('a short empty call keeps the old "retry with the parameters" answer', () => {
    const e = emptyArgsError('remember', ['title', 'content'], 120);
    expect(e.lost).toBe(false);
    expect(e.error).toMatch(/^remember was called without any arguments, but requires: title, content/);
  });

  test('after a long generation it says the call was lost and how to split a file', () => {
    const e = emptyArgsError('workspace_write_file', ['path', 'content'], 3800);
    expect(e.lost).toBe(true);
    expect(e.error).toMatch(/arrived with no arguments after you wrote about 3800 tokens/);
    expect(e.error).toMatch(/You didn't leave anything out/);
    expect(e.error).toMatch(/append=true/);
    expect(emptyArgsError('send_notification', ['message'], LONG_CALL_TOKENS).error).toMatch(/Send less in one call/);
  });
});

describe('workspace_write_file append', () => {
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-append-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctx = () => ({ choom: { name: 'Eve' }, choomId: 'c', send: jest.fn(), sessionFileCount: { created: 0, maxAllowed: 10 } }) as never;
  const write = (args: Record<string, unknown>, c = ctx()) => new WorkspaceFilesHandler().execute({ id: 't', name: 'workspace_write_file', arguments: args }, c);

  test('writes a long file in parts', async () => {
    const c = ctx();
    expect((await write({ path: 'notes/plan.md', content: '# Plan\npart one' }, c)).error).toBeUndefined();
    const r = await write({ path: 'notes/plan.md', content: 'part two\n', append: true }, c);
    expect(r.error).toBeUndefined();
    expect((r.result as Record<string, unknown>).appended).toBe(true);
    expect(fs.readFileSync(path.join(root, 'notes/plan.md'), 'utf-8')).toBe('# Plan\npart one\npart two\n');
    expect((c as unknown as { sessionFileCount: { created: number } }).sessionFileCount.created).toBe(1); // an append is not a new file
  });

  test('append to a file that does not exist yet starts it', async () => {
    const r = await write({ path: 'notes/new.md', content: 'first', append: 'true' });
    expect(r.error).toBeUndefined();
    expect((r.result as Record<string, unknown>).appended).toBeUndefined();
    expect(fs.readFileSync(path.join(root, 'notes/new.md'), 'utf-8')).toBe('first');
  });

  test('without append it still replaces the file', async () => {
    await write({ path: 'a.md', content: 'old' });
    await write({ path: 'a.md', content: 'new' });
    expect(fs.readFileSync(path.join(root, 'a.md'), 'utf-8')).toBe('new');
  });
});
