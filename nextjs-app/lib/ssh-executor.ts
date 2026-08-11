import { execFile } from 'child_process';
import { buildSandboxEnv } from '@/lib/sandbox-env';

const DEFAULT_TIMEOUT_MS = 330_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_REMOTE_COMMAND_BYTES = 32 * 1024;

const SSH_USER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SSH_HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface SshExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

/** Validate the non-option destination passed to the local OpenSSH client. */
export function validateSshTarget(target: unknown): string {
  if (typeof target !== 'string' || !target.trim()) {
    throw new Error('target is required. Use an SSH destination such as "developer@192.0.2.42".');
  }

  const normalized = target.trim();
  const at = normalized.indexOf('@');
  if (at !== normalized.lastIndexOf('@')) {
    throw new Error('Invalid SSH target. Use one optional user@ prefix and a hostname or IPv4 address.');
  }

  const user = at === -1 ? undefined : normalized.slice(0, at);
  const host = at === -1 ? normalized : normalized.slice(at + 1);
  if ((user !== undefined && !SSH_USER_PATTERN.test(user)) || !SSH_HOST_PATTERN.test(host)) {
    throw new Error('Invalid SSH target. Use a hostname, IPv4 address, or SSH config alias without shell syntax.');
  }

  return normalized;
}

export function validateSshPort(port: unknown): number | undefined {
  if (port === undefined || port === null) return undefined;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('port must be an integer from 1 through 65535.');
  }
  return port;
}

export function validateRemoteCommand(command: unknown): string {
  if (typeof command !== 'string' || !command.trim()) {
    throw new Error('command is required. Provide the non-interactive command to run on the remote computer.');
  }
  if (Buffer.byteLength(command, 'utf8') > MAX_REMOTE_COMMAND_BYTES) {
    throw new Error(`command is too large; limit remote commands to ${MAX_REMOTE_COMMAND_BYTES / 1024}KB.`);
  }
  return command;
}

function truncateOutput(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= MAX_OUTPUT_BYTES) return { text, truncated: false };
  return {
    text: Buffer.from(text, 'utf8').subarray(0, MAX_OUTPUT_BYTES).toString('utf8') + '\n... [output truncated at 50KB]',
    truncated: true,
  };
}

/**
 * Runs one non-interactive remote command without invoking a local shell.
 * Authentication and host verification remain the owner's OpenSSH configuration.
 */
export class SshExecutor {
  async run(
    target: unknown,
    command: unknown,
    timeoutMs?: number,
    port?: unknown,
  ): Promise<SshExecutionResult> {
    const sshTarget = validateSshTarget(target);
    const remoteCommand = validateRemoteCommand(command);
    const sshPort = validateSshPort(port);
    const timeout = typeof timeoutMs === 'number' && timeoutMs > 0
      ? Math.min(timeoutMs, MAX_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS;
    const args = [
      '-T',
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=15',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=2',
      ...(sshPort === undefined ? [] : ['-p', String(sshPort)]),
      sshTarget,
      remoteCommand,
    ];
    const start = Date.now();

    return new Promise<SshExecutionResult>((resolve) => {
      execFile('ssh', args, {
        timeout,
        maxBuffer: MAX_OUTPUT_BYTES * 2,
        env: buildSandboxEnv({ PYTHONDONTWRITEBYTECODE: '1' }),
      }, (error, stdout, stderr) => {
        const stdoutResult = truncateOutput(stdout || '');
        const startupError = error && typeof error.code === 'string' ? error : null;
        const stderrText = stderr || (startupError
          ? `ssh failed before the command ran (${startupError.code}): ${startupError.message}`
          : '');
        const stderrResult = truncateOutput(stderrText);

        resolve({
          success: !error,
          stdout: stdoutResult.text,
          stderr: stderrResult.text,
          exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          timedOut: error?.killed === true,
          truncated: stdoutResult.truncated || stderrResult.truncated,
          durationMs: Date.now() - start,
        });
      });
    });
  }
}
