import { WorkspaceService } from '../lib/workspace-service';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Regression tests for the path double-prefix bug that produced errors like:
 *
 *   ENOENT: open '/home/nuc1/choom-projects/home/nuc1/choom-projects/freecad/view.png'
 *
 * resolveSafe() stripped the leading slash off an already-absolute path and
 * then re-joined it under the workspace root. This was the largest single
 * source of 'path'-class tool failures in the trace corpus.
 */
describe('WorkspaceService.resolveSafe', () => {
  let root: string;
  let ws: WorkspaceService;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'choom-ws-'));
    fs.mkdirSync(path.join(root, 'freecad'), { recursive: true });
    ws = new WorkspaceService(root, 1024, ['.png', '.md', '.txt']);
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('resolves a normal relative path', () => {
    expect(ws.resolveSafe('freecad/view.png')).toBe(path.join(root, 'freecad/view.png'));
  });

  it('rebases an absolute path that already points inside the workspace', () => {
    const abs = path.join(root, 'freecad/view.png');
    // The bug: this used to become <root>/<root>/freecad/view.png
    expect(ws.resolveSafe(abs)).toBe(abs);
  });

  it('does not double-prefix the workspace root', () => {
    const abs = path.join(root, 'freecad/view.png');
    const resolved = ws.resolveSafe(abs);
    expect(resolved).not.toContain(path.join(root, root));
    // The root must appear exactly once in the resolved path.
    expect(resolved.split(root).length - 1).toBe(1);
  });

  it('resolves the workspace root itself', () => {
    expect(ws.resolveSafe(root)).toBe(root);
  });

  it('blocks absolute paths outside the workspace', () => {
    expect(() => ws.resolveSafe('/etc/passwd')).toThrow(/Path traversal blocked/);
  });

  it('blocks ../ traversal', () => {
    expect(() => ws.resolveSafe('../../etc/passwd')).toThrow(/Path traversal blocked/);
  });

  it('blocks a sibling directory that shares the root as a string prefix', () => {
    // "<root>-evil" starts with "<root>" but is NOT inside it. A bare
    // startsWith() check would have let this through.
    expect(() => ws.resolveSafe(`${root}-evil/secrets.txt`)).toThrow(/Path traversal blocked/);
  });
});
