import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeSandbox } from '../lib/code-sandbox';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'choom-ssh-guard-test-'));
fs.mkdirSync(path.join(root, 'project'));
const sandbox = new CodeSandbox(root);

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('SSH shell guard', () => {
  it.each([
    'ssh developer@192.0.2.42 hostname',
    '/usr/bin/ssh developer@192.0.2.42 hostname',
  ])('routes direct SSH client %s through the permission-gated tool', async (command) => {
    await expect(sandbox.runCommand('project', command)).rejects.toThrow(/run_ssh_command/);
  });

  it('blocks direct SSH subprocesses from Python code', async () => {
    await expect(
      sandbox.executePython('project', 'import subprocess\nsubprocess.run(["/usr/bin/ssh", "localhost"])')
    ).rejects.toThrow(/run_ssh_command/);
  });

  it('blocks direct SSH subprocesses from Node.js code', async () => {
    await expect(
      sandbox.executeNode('project', "const { execFileSync } = require('child_process'); execFileSync('ssh', ['localhost']);")
    ).rejects.toThrow(/run_ssh_command/);
  });

  it('does not mistake quoted text for an SSH invocation', async () => {
    const result = await sandbox.runCommand('project', 'printf "%s" "ssh"', 60_000);
    expect(result.success).toBe(true);
    expect(result.stdout).toBe('ssh');
  });
});
