/**
 * 2026-10-29/30: the sisters' REED_RULES.md lives in choom_commons/ and in
 * their campfire room's folder. Aloy asked for campfire/REED_RULES.md, Eve for
 * tower_cam/notes/REED_RULES.md, and both got a listing of a folder that
 * didn't have it; the next morning Aloy spent seven rounds on shell find/cat.
 * A missing file now names where a file of that name is, newest first, and
 * a new file whose name already exists elsewhere is saved with a note saying
 * where the others are (Donny: they tend to make the same file in several
 * places, since a file lands wherever the room or project is).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let root: string;
jest.mock('@/lib/db', () => ({ __esModule: true, default: {}, prisma: {} }));
jest.mock('@/lib/config', () => ({ ...jest.requireActual('@/lib/config'), get WORKSPACE_ROOT() { return root; } }));
jest.mock('@/skills/core/image-analysis/handler', () => ({ __esModule: true, default: class {} }));

import WorkspaceFilesHandler, { findWorkspaceFilesNamed } from '@/skills/core/workspace-files/handler';

const put = (rel: string, text: string, mtime?: Date) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  if (mtime) fs.utimesSync(p, mtime, mtime);
};
const run = (name: string, args: Record<string, unknown>) => new WorkspaceFilesHandler().execute(
  { id: 't', name, arguments: args },
  { choom: { name: 'Aloy' }, choomId: 'c', send: jest.fn(), sessionFileCount: { created: 0, maxAllowed: 10 } } as never,
);
const read = (p: string) => run('workspace_read_file', { path: p });
const write = (p: string, content: string, extra: Record<string, unknown> = {}) => run('workspace_write_file', { path: p, content, ...extra });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-name-'));
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); jest.restoreAllMocks(); });

test('a file asked for in the wrong folder is named where it is, newest copy first', async () => {
  put('campfire/gate_ruler/a.md', 'x');
  put('choom_commons/REED_RULES.md', 'old rules', new Date('2026-10-29T18:24:00-06:00'));
  put('choom_commons/rooms/the-campfire-w3jzxr/REED_RULES.md', 'amended rules', new Date('2026-10-29T20:51:00-06:00'));

  const r = await read('campfire/REED_RULES.md');
  expect(r.error).toMatch(/^File not found: "campfire\/REED_RULES\.md"\. Files with that name, newest first:/);
  const room = r.error!.indexOf('choom_commons/rooms/the-campfire-w3jzxr/REED_RULES.md');
  const commons = r.error!.indexOf('choom_commons/REED_RULES.md');
  expect(room).toBeGreaterThan(0);
  expect(commons).toBeGreaterThan(room);
  expect(r.error).not.toMatch(/closest existing directory/);
});

test('names match in any case, and hidden folders are skipped', async () => {
  put('choom_commons/Reed_Rules.md', 'rules');
  put('.choom-skills/REED_RULES.md', 'not this');
  expect(findWorkspaceFilesNamed(root, 'REED_RULES.md').map(f => f.path)).toEqual(['choom_commons/Reed_Rules.md']);
});

test('with no file of that name anywhere, the nearest folder is listed as before', async () => {
  put('tower_cam/notes/evening.md', 'x');
  const r = await read('tower_cam/notes/REED_RULES.md');
  expect(r.error).toMatch(/The closest existing directory is "tower_cam\/notes"/);
  expect(r.error).toContain('evening.md');
});

describe('writing a new file whose name exists elsewhere', () => {
  test('it is saved, and the result says where the others are', async () => {
    put('choom_commons/REED_RULES.md', 'old rules', new Date('2026-10-29T18:24:00-06:00'));
    put('choom_commons/rooms/the-campfire-w3jzxr/REED_RULES.md', 'amended rules', new Date('2026-10-29T20:51:00-06:00'));
    const r = await write('campfire/REED_RULES.md', 'my rules');
    expect(r.error).toBeUndefined();
    expect(fs.readFileSync(path.join(root, 'campfire/REED_RULES.md'), 'utf-8')).toBe('my rules');
    const note = (r.result as { note?: string }).note!;
    expect(note).toMatch(/^Saved as a new file\. Other files with this name already exist, newest first:/);
    expect(note.indexOf('choom_commons/rooms/the-campfire-w3jzxr/REED_RULES.md')).toBeLessThan(note.indexOf('choom_commons/REED_RULES.md'));
    expect(note).not.toContain('📄 campfire/REED_RULES.md'); // not the file she just made
    expect(note).toMatch(/update it instead \(append=true adds to the end\)/);
  });

  test('no note when the name is new, or when updating a file that is already there', async () => {
    put('choom_commons/REED_RULES.md', 'rules');
    expect((await write('campfire/gate_notes.md', 'x')).result).not.toHaveProperty('note');
    expect((await write('choom_commons/REED_RULES.md', 'rules v2')).result).not.toHaveProperty('note');
    expect((await write('campfire/REED_RULES.md', 'part 1', { append: true })).result).toHaveProperty('note'); // a new file, even by append
    expect((await write('campfire/REED_RULES.md', 'part 2', { append: true })).result).not.toHaveProperty('note');
  });

  test('names every project has its own of are not flagged', async () => {
    put('freecad/README.md', 'x');
    expect((await write('campfire/README.md', 'y')).result).not.toHaveProperty('note');
  });
});
