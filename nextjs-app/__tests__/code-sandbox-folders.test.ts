/**
 * CodeSandbox project-folder resolution (C-54).
 *
 * A nonexistent cwd used to surface as spawn ENOENT with EMPTY stdout/stderr
 * in ~3ms — two of those in a row read as "the workspace environment is
 * completely non-functional" (Lissa, 17-iteration live incident). The
 * resolver now names the real folders; residual spawn failures explain
 * themselves; ordinary nonzero exits stay untouched.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeSandbox } from '../lib/code-sandbox';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'choom-sandbox-test-'));
fs.mkdirSync(path.join(root, 'real_project'));
const sb = new CodeSandbox(root);

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('missing project folder', () => {
  test('names the real folders instead of a bare spawn ENOENT', async () => {
    await expect(sb.runCommand('no-such-folder', 'echo hi')).rejects.toThrow(
      /doesn't exist — don't guess folder names.*real_project.*workspace_create_folder/s,
    );
  });

  test('execute paths get the same guard', async () => {
    await expect(sb.executePython('nope-folder', 'print(1)')).rejects.toThrow(/doesn't exist/);
  });
});

describe('existing project folder', () => {
  test('commands run and succeed', async () => {
    const r = await sb.runCommand('real_project', 'echo ok');
    expect(r.success).toBe(true);
    expect(r.stdout.trim()).toBe('ok');
  });

  test('a plain nonzero exit is NOT dressed up as a spawn failure', async () => {
    const r = await sb.runCommand('real_project', 'false');
    expect(r.success).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).not.toContain('spawn failed');
  });

  test('a real command-not-found keeps the shell error text', async () => {
    const r = await sb.runCommand('real_project', 'definitely_not_a_command_xyz');
    expect(r.success).toBe(false);
    expect(r.stderr).toContain('not found');
  });
});
