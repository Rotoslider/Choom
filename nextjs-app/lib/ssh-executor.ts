import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { buildSandboxEnv } from '@/lib/sandbox-env';
import { WORKSPACE_ROOT } from '@/lib/config';

// 240s: must stay UNDER the group-room idle watchdog (300s of zero stream
// bytes kills the whole speaker turn — 2026-08-25: Eve's hung run_ssh_command
// produced 304s of silence, so the watchdog fired 4s before this timeout
// could return a clean, model-actionable error). Explicit timeout_seconds may
// exceed it, but rooms will reap such calls at 300s regardless.
const DEFAULT_TIMEOUT_MS = 240_000;
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

/** Escape a received value for error messages so models can SEE what arrived
 *  (control chars, stray quotes) instead of guessing whether serialization
 *  mangled it. Truncated — targets are not secrets. */
export function previewReceived(v: unknown): string {
  const s = typeof v === 'string' ? v : String(v);
  return JSON.stringify(s.length > 100 ? s.slice(0, 100) + '…' : s);
}

/**
 * Normalize raw `target` input: trim, then strip ONE layer of stray wrapping
 * quotes (models sometimes serialize the value with quotes baked in).
 */
function normalizeTargetInput(target: unknown): string {
  let s = typeof target === 'string' ? target.trim() : '';
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

/**
 * Models frequently serialize classic scp syntax ("user@host:/abs/path")
 * into `target`. Detect that shape so ssh_copy_file can honor the intent by
 * splitting; run_ssh_command gets a precise "use ssh_copy_file" error instead
 * of a generic one.
 */
export function splitScpStyleTarget(raw: unknown): { spec: string; remotePath?: string } {
  const t = normalizeTargetInput(raw);
  // user@host:rest — host part forbids ':' anyway, so any ':' here is scp-style.
  const m = t.match(/^([^@\s]+@[^:\s]+):(.*)$/);
  if (!m) return { spec: t };
  return { spec: m[1], remotePath: m[2] };
}

/** Validate the non-option destination passed to the local OpenSSH client. */
export function validateSshTarget(target: unknown): string {
  if (typeof target !== 'string' || !target.trim()) {
    throw new Error(`target is required (e.g. "mypie4@192.0.0.68"); received ${previewReceived(target)}.`);
  }

  const normalized = normalizeTargetInput(target);
  const at = normalized.indexOf('@');
  if (at !== normalized.lastIndexOf('@')) {
    throw new Error(`Invalid SSH target ${previewReceived(target)}: use ONE user@ prefix and a hostname or IPv4 address.`);
  }

  const user = at === -1 ? undefined : normalized.slice(0, at);
  const host = at === -1 ? normalized : normalized.slice(at + 1);
  if ((user !== undefined && !SSH_USER_PATTERN.test(user)) || !SSH_HOST_PATTERN.test(host)) {
    throw new Error(
      `Invalid SSH target ${previewReceived(target)}: expected bare user@host like "mypie4@192.0.0.68" ` +
      `(no quotes, spaces, ":path" suffixes, or shell syntax). ` +
      `For file copies put the path in remote_path and call ssh_copy_file instead.`,
    );
  }

  return normalized;
}

const REMOTE_PATH_PATTERN = /^[^`$;&|<>()\r\n\\]{1,512}$/;

/**
 * Validate a remote-side path for scp. scp hands the remote path to the
 * REMOTE shell, so metacharacters would execute over there — allow only
 * plain absolute or ~-relative paths.
 */
export function validateSshRemotePath(p: unknown, label = 'remote_path'): string {
  if (typeof p !== 'string' || !p.trim()) {
    throw new Error(`${label} is required. Use a plain absolute path like "/home/pi/data.bin" or "~/out.txt".`);
  }
  const v = p.trim();
  if (v.startsWith('-')) {
    throw new Error(`${label} must not start with "-" — pass a plain path, not an option.`);
  }
  if (!REMOTE_PATH_PATTERN.test(v)) {
    throw new Error(`${label} contains shell metacharacters (backtick $ ; & | < > parentheses). scp passes the remote path to the remote shell — use plain paths only.`);
  }
  return v;
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

  /**
   * Binary-safe file transfer over the same permission-gated OpenSSH client
   * (scp under the hood; no local shell involved). `localPath` is
   * WORKSPACE-RELATIVE and is resolved + contained here so every caller
   * (skill dispatch and legacy dispatch) shares one policy.
   * direction 'pull' = remote → workspace, 'push' = workspace → remote.
   */
  async copy(opts: {
    direction: unknown;
    target: unknown;
    remotePath?: unknown;
    localPath: unknown;
    timeoutMs?: number;
    port?: unknown;
  }): Promise<SshExecutionResult & { localPath: string }> {
    if (opts.direction !== 'pull' && opts.direction !== 'push') {
      throw new Error('direction must be "pull" (remote → workspace) or "push" (workspace → remote).');
    }
    const direction: 'pull' | 'push' = opts.direction;
    // Models reach for classic scp syntax ("user@host:/abs/path") in `target`.
    // Honor it: split and use the embedded path unless an explicit remote_path
    // was also passed (conflict → error naming both).
    const split = splitScpStyleTarget(opts.target);
    const explicitRemote = typeof opts.remotePath === 'string' ? opts.remotePath.trim() : '';
    if (split.remotePath !== undefined && explicitRemote && explicitRemote !== split.remotePath) {
      throw new Error(
        `Conflicting remote paths: target embeds ${previewReceived(split.remotePath)} but remote_path is ${previewReceived(explicitRemote)}. Pass one or the other.`,
      );
    }
    const effectiveRemote = explicitRemote || split.remotePath;
    const sshTarget = validateSshTarget(split.spec);
    if (effectiveRemote === undefined || effectiveRemote === '') {
      throw new Error(
        `remote_path is required (e.g. "/home/pi/data.bin"). If you meant the scp-style form, "target": "${split.spec}:/home/pi/data.bin" also works — the path is split out automatically.`,
      );
    }
    const remotePath = validateSshRemotePath(effectiveRemote);
    const sshPort = validateSshPort(opts.port);

    const relLocal = typeof opts.localPath === 'string' ? opts.localPath.trim() : '';
    if (!relLocal) {
      throw new Error('local_path is required (workspace-relative path, e.g. "myproject/data.bin").');
    }
    const absLocal = path.resolve(WORKSPACE_ROOT, relLocal);
    const rootWithSep = WORKSPACE_ROOT.endsWith(path.sep) ? WORKSPACE_ROOT : WORKSPACE_ROOT + path.sep;
    if (!absLocal.startsWith(rootWithSep)) {
      throw new Error('local_path must stay inside the Choom workspace folder.');
    }
    if (direction === 'push') {
      if (!fs.existsSync(absLocal)) {
        throw new Error(`local_path "${relLocal}" does not exist in the workspace — write it first (workspace_write_file), then push it.`);
      }
    } else {
      fs.mkdirSync(path.dirname(absLocal), { recursive: true });
    }

    const timeout = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0
      ? Math.min(opts.timeoutMs, MAX_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS;
    const remoteSpec = `${sshTarget}:${remotePath}`;
    const args = [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=15',
      ...(sshPort === undefined ? [] : ['-P', String(sshPort)]),
      ...(direction === 'push' ? [absLocal, remoteSpec] : [remoteSpec, absLocal]),
    ];
    const start = Date.now();
    const { promise, resolve } = Promise.withResolvers<SshExecutionResult & { localPath: string }>();
    execFile('scp', args, {
      timeout,
      maxBuffer: 1024 * 1024,
      env: buildSandboxEnv({}),
    }, (error, stdout, stderr) => {
      const startupError = error && typeof error.code === 'string' ? error : null;
      const stderrText = stderr || (startupError
        ? `scp failed before transferring (${startupError.code}): ${startupError.message}`
        : '');
      const stderrResult = truncateOutput(stderrText);
      resolve({
        success: !error,
        stdout: truncateOutput(stdout || '').text,
        stderr: stderrResult.text,
        exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        timedOut: error?.killed === true,
        truncated: stderrResult.truncated,
        durationMs: Date.now() - start,
        localPath: path.relative(WORKSPACE_ROOT, absLocal) || relLocal,
      });
    });
    return promise;
  }
}
