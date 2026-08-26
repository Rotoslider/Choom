/**
 * ssh_copy_file — binary-safe workspace ↔ remote transfers over the same
 * permission-gated OpenSSH client as run_ssh_command.
 *
 * Production context (2026-08-25): the Chooms kept trying to move files
 * between the pie and the nuc with shell workarounds (run_command + ssh/scp —
 * blocked by the sandbox gate; typo'd "scl") because no first-class transfer
 * tool existed. Genesis then hit "Invalid SSH target" repeatedly because she
 * serialized classic scp syntax ("user@host:/path") into `target` — and the
 * generic error gave her nothing to correct. These tests pin:
 *   • registration + permission gate
 *   • scp-style target auto-splitting (and conflict detection)
 *   • error messages that SHOW the received value so "mangled wire" claims
 *     are checkable in one glance
 *   • path-validation rules keeping metacharacters away from scp's remote shell
 */
import { readFileSync } from 'fs';
import path from 'path';
import CodeExecutionHandler from '../skills/core/code-execution/handler';
import { REMOTE_SSH_DISABLED_MESSAGE } from '../lib/choom-permissions';
import {
  SshExecutor,
  previewReceived,
  splitScpStyleTarget,
  validateSshRemotePath,
  validateSshTarget,
} from '../lib/ssh-executor';
import type { SkillHandlerContext } from '../lib/skill-handler';
import type { ToolCall } from '../lib/types';

const deniedContext = {
  choom: { permissions: { ssh: false } },
} as unknown as SkillHandlerContext;

const copyCall: ToolCall = {
  id: 'ssh-copy-denied-test',
  name: 'ssh_copy_file',
  arguments: {
    direction: 'pull',
    target: 'pi@192.0.2.42',
    remote_path: '/home/pi/data.bin',
    local_path: 'myproject/data.bin',
  },
};

describe('ssh_copy_file', () => {
  it('is registered by the code-execution skill', () => {
    expect(new CodeExecutionHandler().canHandle('ssh_copy_file')).toBe(true);
  });

  it('denies a Choom without the explicit SSH grant before touching OpenSSH', async () => {
    const result = await new CodeExecutionHandler().execute(copyCall, deniedContext);
    expect(result.error).toBe(REMOTE_SSH_DISABLED_MESSAGE);
  });
});

describe('splitScpStyleTarget', () => {
  it('passes bare user@host through untouched', () => {
    expect(splitScpStyleTarget('mypie4@192.0.0.68')).toEqual({ spec: 'mypie4@192.0.0.68' });
  });

  it('splits the classic scp form into target + path', () => {
    expect(splitScpStyleTarget('mypie4@192.0.0.68:/home/pi/0106ebe.bin')).toEqual({
      spec: 'mypie4@192.0.0.68',
      remotePath: '/home/pi/0106ebe.bin',
    });
  });

  it('strips one layer of stray wrapping quotes first', () => {
    expect(splitScpStyleTarget('"mypie4@192.0.0.68"')).toEqual({ spec: 'mypie4@192.0.0.68' });
    // Quoted AND scp-style both handled in one pass.
    expect(splitScpStyleTarget("'pi@pie:~/x.bin'")).toEqual({ spec: 'pi@pie', remotePath: '~/x.bin' });
  });

  it('keeps a trailing colon as an empty embedded path (targeted error downstream)', () => {
    expect(splitScpStyleTarget('mypie4@192.0.0.68:')).toEqual({
      spec: 'mypie4@192.0.0.68',
      remotePath: '',
    });
  });
});

describe('validateSshTarget diagnostics', () => {
  it('accepts the exact destination format the chooms were told to use', () => {
    expect(validateSshTarget('mypie4@192.0.0.68')).toBe('mypie4@192.0.0.68');
  });

  it('shows the received value when rejecting garbage', () => {
    try {
      validateSshTarget('mypie4@192.0.0.68 -oProxyCommand=evil');
      throw new Error('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('"mypie4@192.0.0.68 -oProxyCommand=evil"'); // previewReceived echo
      expect(msg).toContain('ssh_copy_file');
    }
  });

  it('rejects values with spaces or an empty host cleanly', () => {
    expect(() => validateSshTarget('my pie@192.0.0.68')).toThrow(/Invalid SSH target/);
    expect(() => validateSshTarget('mypie4@')).toThrow(/Invalid SSH target/);
    // A bare hostname is VALID (no user@ prefix required) — must not throw.
    expect(validateSshTarget('pie-host')).toBe('pie-host');
  });

  it('previewReceived escapes control characters', () => {
    expect(previewReceived('a\nb')).toBe('"a\\nb"');
  });
});

describe('copy() target/path resolution errors (all thrown before any spawn)', () => {
  const executor = new SshExecutor();

  it('honors the scp-style combined target', async () => {
    // Validation order: direction → split → local-path containment → spawn.
    // Use a local_path OUTSIDE the workspace to fail deterministically AFTER
    // the split resolved cleanly (proves split didn't throw).
    await expect(executor.copy({
      direction: 'pull',
      target: 'mypie4@192.0.0.68:/home/pi/0106ebe.bin',
      localPath: '../../etc/passwd',
    })).rejects.toThrow(/local_path must stay inside the Choom workspace/);
  });

  it('reports conflicting embedded vs explicit remote paths', async () => {
    await expect(executor.copy({
      direction: 'pull',
      target: 'mypie4@192.0.0.68:/home/pi/a.bin',
      remotePath: '/different/b.bin',
      localPath: 'f.bin',
    })).rejects.toThrow(/Conflicting remote paths/);
  });

  it('turns a trailing colon into a teachable remote_path error', async () => {
    await expect(executor.copy({
      direction: 'push',
      target: 'mypie4@192.0.0.68:',
      remotePath: undefined,
      localPath: 'f.bin',
    })).rejects.toThrow(/remote_path is required.*scp-style form/s);
  });
});

describe('validateSshRemotePath', () => {
  it('accepts plain absolute and ~-relative paths', () => {
    expect(validateSshRemotePath('/home/pi/data.bin')).toBe('/home/pi/data.bin');
    expect(validateSshRemotePath('~/out.txt')).toBe('~/out.txt');
    expect(validateSshRemotePath(' relative/dir/file.csv ')).toBe('relative/dir/file.csv');
  });

  it('rejects missing values', () => {
    expect(() => validateSshRemotePath(undefined)).toThrow(/remote_path is required/);
    expect(() => validateSshRemotePath('   ')).toThrow(/remote_path is required/);
  });

  it('rejects option injection', () => {
    expect(() => validateSshRemotePath('-oProxyCommand=evil')).toThrow(/must not start with "-"|plain path/);
  });

  it('rejects shell metacharacters (scp passes them to the REMOTE shell)', () => {
    expect(() => validateSshRemotePath('/tmp/x; rm -rf /')).toThrow(/metacharacters/);
    expect(() => validateSshRemotePath('$(id)')).toThrow(/metacharacters/);
    expect(() => validateSshRemotePath('a`id`b')).toThrow(/metacharacters/);
    expect(() => validateSshRemotePath('/tmp/a|b')).toThrow(/metacharacters/);
    expect(() => validateSshRemotePath('/tmp/a&b')).toThrow(/metacharacters/);
  });
});

describe('stateful-tool dedup exemption', () => {
  const loopSrc = readFileSync(path.join(__dirname, '..', 'lib', 'agentic-loop.ts'), 'utf-8');

  test('SSH tools are exempt from stale-result caching', () => {
    // Eve re-ran the SAME verification command between patch attempts and was
    // served cached pre-patch output — then the repeat detector killed her turn
    // for "looping" on what were legitimate re-verifications of a changed world.
    expect(loopSrc).toContain("'run_ssh_command', 'ssh_copy_file',");
  });
});
