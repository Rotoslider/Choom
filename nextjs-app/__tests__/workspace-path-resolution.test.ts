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

  it('treats a leading-slash workspace path as workspace-relative', () => {
    // Chooms routinely write "/choom_commons/for_eve/note.md" meaning
    // "choom_commons/for_eve/note.md". Replaying every path argument in
    // data/traces, 24 distinct real paths take this branch and all 24 are
    // genuine workspace folders. Rejecting them broke cross-Choom letters,
    // camera snapshots and uploads, so they are rebased, not refused.
    expect(ws.resolveSafe('/freecad/view.png')).toBe(path.join(root, 'freecad/view.png'));
  });

  it('contains an absolute system path inside the workspace rather than escaping', () => {
    // Not an error — it resolves to <root>/etc/passwd and fails later as
    // not-found. What matters is that it never reaches the real /etc/passwd.
    const r = ws.resolveSafe('/etc/passwd');
    expect(r.startsWith(root + path.sep)).toBe(true);
    expect(r).not.toBe('/etc/passwd');
  });

  it('blocks ../ traversal', () => {
    expect(() => ws.resolveSafe('../../etc/passwd')).toThrow(/Path traversal blocked/);
  });

  it('never resolves into a sibling directory that shares the root as a prefix', () => {
    // "<root>-evil" starts with "<root>" but is NOT inside it. The result must
    // stay under the real root — a bare startsWith() containment check would
    // have let the sibling through.
    const r = ws.resolveSafe(`${root}-evil/secrets.txt`);
    expect(r.startsWith(root + path.sep)).toBe(true);
    expect(r).not.toBe(`${root}-evil/secrets.txt`);
  });

  it('blocks traversal that would escape the root', () => {
    expect(() => ws.resolveSafe('a/../../../../etc/shadow')).toThrow(/Path traversal blocked/);
  });
});
