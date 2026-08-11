import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  SshExecutor,
  validateRemoteCommand,
  validateSshPort,
  validateSshTarget,
} from '../lib/ssh-executor';

describe('SSH executor input validation', () => {
  it('accepts the local-network SSH destination format', () => {
    expect(validateSshTarget('developer@192.0.2.42')).toBe('developer@192.0.2.42');
    expect(validateSshTarget('build-host')).toBe('build-host');
    expect(validateSshPort(22)).toBe(22);
  });

  it.each([
    '-oProxyCommand=malicious',
    'developer@192.0.2.42; rm -rf /',
    'developer@@192.0.2.42',
    '@192.0.2.42',
  ])('rejects shell syntax in target %s', (target) => {
    expect(() => validateSshTarget(target)).toThrow(/Invalid SSH target/);
  });

  it('rejects invalid ports and missing remote commands', () => {
    expect(() => validateSshPort(0)).toThrow(/1 through 65535/);
    expect(() => validateSshPort('22')).toThrow(/1 through 65535/);
    expect(() => validateRemoteCommand('   ')).toThrow(/command is required/);
  });
});

describe('SSH process execution', () => {
  const originalPath = process.env.PATH;
  let binDir = '';

  beforeEach(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choom-fake-ssh-'));
    const fakeSsh = path.join(binDir, 'ssh');
    fs.writeFileSync(fakeSsh, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    process.env.PATH = `${binDir}${path.delimiter}${originalPath || ''}`;
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  it('executes a remote command as separate OpenSSH arguments', async () => {
    const result = await new SshExecutor().run('developer@192.0.2.42', 'printf ready', undefined, 2222);

    expect(result).toMatchObject({ success: true, exitCode: 0, timedOut: false });
    expect(result.stdout.trim().split('\n')).toEqual([
      '-T',
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=15',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=2',
      '-p', '2222',
      'developer@192.0.2.42',
      'printf ready',
    ]);
  });
});
