/**
 * 2026-10-29: Eve read tower_cam/evening_tower_oct28_2100.jpg with
 * workspace_read_file and got an error telling her to call analyze_image —
 * a wasted round, counted as a tool failure. A read of a picture now looks at it.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let root: string;
jest.mock('@/lib/db', () => ({ __esModule: true, default: {}, prisma: {} }));
jest.mock('@/lib/config', () => ({ ...jest.requireActual('@/lib/config'), get WORKSPACE_ROOT() { return root; } }));
const look = jest.fn();
jest.mock('@/skills/core/image-analysis/handler', () => ({
  __esModule: true,
  default: class { execute(call: { arguments: Record<string, unknown> }) { return look(call); } },
}));

import WorkspaceFilesHandler from '@/skills/core/workspace-files/handler';

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-img-')); look.mockReset(); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const read = (p: string) => new WorkspaceFilesHandler().execute(
  { id: 't', name: 'workspace_read_file', arguments: { path: p } },
  { choom: { name: 'Eve' }, choomId: 'c', send: jest.fn(), sessionFileCount: { created: 0, maxAllowed: 10 } } as never,
);

test('reading a picture returns what the vision model sees, in one call', async () => {
  look.mockResolvedValue({ toolCallId: 'x', name: 'analyze_image', result: { analysis: 'The tower at dusk; the gate is closed.', model: 'v' } });
  const r = await read('tower_cam/evening_tower_oct28_2100.jpg');
  expect(r.error).toBeUndefined();
  const out = r.result as Record<string, unknown>;
  expect(out.kind).toBe('image');
  expect(out.description).toBe('The tower at dusk; the gate is closed.');
  expect(look).toHaveBeenCalledWith(expect.objectContaining({ arguments: expect.objectContaining({ image_path: 'tower_cam/evening_tower_oct28_2100.jpg' }) }));
});

test('when the look fails, its own error comes back', async () => {
  look.mockResolvedValue({ toolCallId: 'x', name: 'analyze_image', result: null, error: 'File not found: "tower_cam/nope.jpg". Here is what is in tower_cam/: …' });
  const r = await read('tower_cam/nope.jpg');
  expect(r.error).toMatch(/^File not found: "tower_cam\/nope\.jpg"/);
});

test('text files are read as before', async () => {
  fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(root, 'notes/a.md'), 'hello');
  const r = await read('notes/a.md');
  expect(r.error).toBeUndefined();
  expect(look).not.toHaveBeenCalled();
  expect(JSON.stringify(r.result)).toContain('hello');
});
