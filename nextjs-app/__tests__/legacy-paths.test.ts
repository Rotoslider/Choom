/**
 * The NUC's projects folder in a Choom's own command or code (lib/legacy-paths.ts): mapped to the real
 * one on the Mac, with a note in the result, so `find /home/nuc1/choom-projects ...` stops quietly
 * finding nothing.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { translateLegacyPaths, legacyPathNote } from '@/lib/legacy-paths';

const ROOT = '/Users/someone/choom-projects';

describe('translateLegacyPaths', () => {
  test('the old folder, wherever it appears, points at the real one', () => {
    const cmd = 'cd /home/nuc1/choom-projects/selfies_eve && ls; find /home/nuc1/choom-projects -iname "*REED*" 2>/dev/null';
    const r = translateLegacyPaths(cmd, ROOT);
    expect(r.changed).toBe(true);
    expect(r.text).toBe(`cd ${ROOT}/selfies_eve && ls; find ${ROOT} -iname "*REED*" 2>/dev/null`);
  });

  test('inside quotes in code, and at the end of a string', () => {
    const code = 'base = "/home/nuc1/choom-projects/selfies_eve"\nroot = \'/home/nuc1/choom-projects\'';
    expect(translateLegacyPaths(code, ROOT).text).toBe(`base = "${ROOT}/selfies_eve"\nroot = '${ROOT}'`);
  });

  test('other paths are left alone', () => {
    for (const s of ['/home/nuc1/choom-projects-old/x', '/home/nuc1/other/file', '/home/pi/data.bin', 'choom-projects/x', '']) {
      expect(translateLegacyPaths(s, ROOT)).toEqual({ text: s, changed: false });
    }
  });

  test('nothing to do when the projects folder really is the old one', () => {
    expect(translateLegacyPaths('/home/nuc1/choom-projects/x', '/home/nuc1/choom-projects').changed).toBe(false);
  });

  test('the note names the real folder', () => {
    expect(legacyPathNote(ROOT)).toMatch(new RegExp(`read as ${ROOT}`));
  });
});

describe('run_command and execute_code with the old path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'choom-legacy-paths-'));
  fs.mkdirSync(path.join(root, 'proj'));
  fs.writeFileSync(path.join(root, 'proj', 'hello.txt'), 'hi from the Mac\n');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let handler: any;

  beforeAll(async () => {
    process.env.WORKSPACE_ROOT = root;
    jest.resetModules();
    const mod = await import('@/skills/core/code-execution/handler');
    handler = new mod.default();
  });
  afterAll(() => {
    delete process.env.WORKSPACE_ROOT;
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('run_command reads the file at the real place and says why', async () => {
    const r = await handler.execute({ id: 't1', name: 'run_command', arguments: { project_folder: 'proj', command: 'cat /home/nuc1/choom-projects/proj/hello.txt' } }, {});
    expect(r.error).toBeFalsy();
    expect(r.result.stdout.trim()).toBe('hi from the Mac');
    expect(r.result.note).toMatch(/old NUC folder/);
  });

  test('the project folder is found from the old absolute path too', async () => {
    const r = await handler.execute({ id: 't2', name: 'run_command', arguments: { command: 'ls /home/nuc1/choom-projects/proj' } }, {});
    expect(r.error).toBeFalsy();
    expect(r.result.stdout).toMatch(/hello\.txt/);
  });

  test('execute_code (python) gets the same', async () => {
    const r = await handler.execute({ id: 't3', name: 'execute_code', arguments: { project_folder: 'proj', language: 'python', code: 'print(open("/home/nuc1/choom-projects/proj/hello.txt").read().strip())' } }, {});
    expect(r.error).toBeFalsy();
    expect(r.result.stdout.trim()).toBe('hi from the Mac');
    expect(r.result.note).toMatch(/old NUC folder/);
  });

  test('a command without the old path has no note', async () => {
    const r = await handler.execute({ id: 't4', name: 'run_command', arguments: { project_folder: 'proj', command: 'cat hello.txt' } }, {});
    expect(r.result.stdout.trim()).toBe('hi from the Mac');
    expect(r.result.note).toBeUndefined();
  });
});
