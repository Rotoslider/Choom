/**
 * Code Sandbox Service
 * Provides sandboxed code execution for Python and Node.js within workspace project folders.
 * Uses child_process with timeout enforcement and output truncation.
 */

import { exec } from 'child_process';
import { writeFile, unlink, access } from 'fs/promises';
import path from 'path';
import { randomBytes } from 'crypto';
import { markGpuBusy, markGpuFree } from './gpu-lock';

interface ExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 330_000; // 5.5 min — autoresearch and training scripts need time
const MAX_TIMEOUT_MS = 600_000; // 10 min — package installs (PyTorch, CUDA) need time
const MAX_OUTPUT_BYTES = 50 * 1024; // 50KB

/** Commands that hang or are dangerous in non-interactive sandbox */
const BLOCKED_COMMAND_PATTERNS = [
  /\bsudo\b/,           // hangs waiting for password on stdin
  /\bsu\b\s/,           // switch user — same problem
  /\bsystemctl\b/,      // needs root, can affect host services
  /\breboot\b/,
  /\bshutdown\b/,
  /\bpoweroff\b/,
  /\bhalt\b/,
  /\brm\s+(-[^\s]*)?-rf?\s+\/(?!\w)/,  // rm -rf / (root filesystem)
  /\bmkfs\b/,           // format filesystem
  /\bdd\b\s.*of=\/dev/,  // raw disk write
];

/**
 * Strip heredoc bodies and quoted strings from a command before pattern
 * matching. The blocked-pattern check should only scan the actual shell
 * scaffolding — content the user is feeding INTO a command (file bodies via
 * heredoc, quoted string literals) doesn't execute as a command, so seeing
 * the word "sudo" in a research note shouldn't trigger the sudo block.
 */
function stripQuotedAndHeredocs(cmd: string): string {
  let s = cmd;
  // Heredoc bodies: <<[-]'?DELIM'? ... DELIM
  s = s.replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?(?:\n|^)\s*\1\b/g, '<<STRIPPED');
  // Heredoc without a closing delimiter (still being written) — strip
  // everything from the heredoc-start marker onward.
  s = s.replace(/<<-?\s*['"]?\w+['"]?[\s\S]*$/, '<<STRIPPED');
  // Single-quoted strings (no escapes inside in shell)
  s = s.replace(/'[^']*'/g, "'STR'");
  // Double-quoted strings (simple escape handling)
  s = s.replace(/"(?:[^"\\]|\\.)*"/g, '"STR"');
  return s;
}

function validateCommand(command: string): void {
  // Run pattern checks against the stripped form so a literal "sudo" in a
  // heredoc body or quoted string doesn't cause a false positive. The
  // shell still sees the original command at runtime — this only affects
  // our pre-flight regex screening.
  const scanned = stripQuotedAndHeredocs(command);
  for (const pattern of BLOCKED_COMMAND_PATTERNS) {
    if (pattern.test(scanned)) {
      throw new Error(
        `Blocked command: "${command.slice(0, 80)}" — ` +
        `matched "${pattern.source}". ` +
        `Commands requiring sudo/root cannot run in the sandbox (they hang waiting for a password). ` +
        `If this command requires elevated privileges, ask the user to run it manually.`
      );
    }
  }
}

export class CodeSandbox {
  private workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = path.resolve(workspaceRoot);
  }

  /** Resolve and validate a project folder path within the workspace */
  private resolveProject(projectFolder: string): string {
    if (!projectFolder || typeof projectFolder !== 'string') {
      throw new Error('project_folder is required. Provide the project folder name (e.g., "my_project")');
    }
    const cleaned = projectFolder.replace(/^[/\\]+/, '');
    const resolved = path.resolve(this.workspaceRoot, cleaned);
    if (!resolved.startsWith(this.workspaceRoot)) {
      throw new Error(`Path traversal blocked: "${projectFolder}" resolves outside workspace`);
    }
    return resolved;
  }

  /** Truncate output to max bytes */
  private truncateOutput(text: string): { text: string; truncated: boolean } {
    const bytes = Buffer.byteLength(text, 'utf-8');
    if (bytes <= MAX_OUTPUT_BYTES) {
      return { text, truncated: false };
    }
    // Truncate by slicing the buffer
    const buf = Buffer.from(text, 'utf-8').subarray(0, MAX_OUTPUT_BYTES);
    return {
      text: buf.toString('utf-8') + '\n... [output truncated at 50KB]',
      truncated: true,
    };
  }

  /** Check if a venv exists in the project folder */
  private async findVenvPython(projectDir: string): Promise<string | null> {
    for (const venvDir of ['venv', '.venv']) {
      const pythonPath = path.join(projectDir, venvDir, 'bin', 'python');
      try {
        await access(pythonPath);
        return pythonPath;
      } catch { /* not found */ }
    }
    return null;
  }

  /** Run a shell command in a project folder */
  async runCommand(projectFolder: string, command: string, timeoutMs?: number): Promise<ExecutionResult> {
    validateCommand(command);
    const projectDir = this.resolveProject(projectFolder);
    const timeout = Math.min(timeoutMs || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const start = Date.now();

    // Auto-activate venv if available
    const venvPython = await this.findVenvPython(projectDir);
    let shellCommand = command;
    if (venvPython) {
      const venvDir = path.dirname(path.dirname(venvPython));
      shellCommand = `source "${path.join(venvDir, 'bin', 'activate')}" && ${command}`;
    }

    // Track GPU-intensive commands. Two patterns:
    // 1. Long-running foreground commands (timeout > 60s) — training, inference
    // 2. Background commands (nohup/&) that launch GPU processes and return immediately
    const isLongRunning = timeout > 60_000;
    const isBackgroundGpu = /\b(nohup|&\s*$)/.test(command) && /\b(python|train|inference|torch|cuda)\b/i.test(command);
    if (isLongRunning || isBackgroundGpu) {
      markGpuBusy(`run_command: ${command.slice(0, 80)}`);
    }

    return new Promise<ExecutionResult>((resolve) => {
      const proc = exec(shellCommand, {
        cwd: projectDir,
        timeout,
        maxBuffer: MAX_OUTPUT_BYTES * 2,
        shell: '/bin/bash',
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      }, (error, stdout, stderr) => {
        if (isLongRunning && !isBackgroundGpu) markGpuFree();
        // Background GPU commands: don't release here — the process is still running.
        // GPU will be released when the next nvidia-smi/ps check shows it's idle,
        // or after a timeout. Schedule a delayed release as a safety net.
        if (isBackgroundGpu) {
          const bgTimeout = 600_000; // 10 min safety net
          console.log(`   🔒 Background GPU process detected — GPU lock held for up to ${bgTimeout / 1000}s`);
          setTimeout(() => markGpuFree(), bgTimeout);
        }
        const durationMs = Date.now() - start;
        const timedOut = error?.killed === true;
        const stdoutResult = this.truncateOutput(stdout || '');
        const stderrResult = this.truncateOutput(stderr || '');

        resolve({
          success: !error,
          stdout: stdoutResult.text,
          stderr: stderrResult.text,
          exitCode: error ? (error as any).code ?? 1 : 0,
          timedOut,
          truncated: stdoutResult.truncated || stderrResult.truncated,
          durationMs,
        });
      });
    });
  }

  /** Execute Python code in a project folder */
  async executePython(projectFolder: string, code: string, timeoutMs?: number): Promise<ExecutionResult> {
    const projectDir = this.resolveProject(projectFolder);
    const timeout = Math.min(timeoutMs || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const tempFile = path.join(projectDir, `_choom_tmp_${randomBytes(4).toString('hex')}.py`);
    const start = Date.now();

    try {
      await writeFile(tempFile, code, 'utf-8');

      // Use venv python if available, otherwise system python3
      const venvPython = await this.findVenvPython(projectDir);
      const pythonBin = venvPython || 'python3';

      return new Promise<ExecutionResult>((resolve) => {
        exec(`"${pythonBin}" "${tempFile}"`, {
          cwd: projectDir,
          timeout,
          maxBuffer: MAX_OUTPUT_BYTES * 2,
          shell: '/bin/bash',
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
        }, (error, stdout, stderr) => {
          const durationMs = Date.now() - start;
          const timedOut = error?.killed === true;
          const stdoutResult = this.truncateOutput(stdout || '');
          const stderrResult = this.truncateOutput(stderr || '');

          resolve({
            success: !error,
            stdout: stdoutResult.text,
            stderr: stderrResult.text,
            exitCode: error ? (error as any).code ?? 1 : 0,
            timedOut,
            truncated: stdoutResult.truncated || stderrResult.truncated,
            durationMs,
          });
        });
      });
    } finally {
      try { await unlink(tempFile); } catch { /* already cleaned */ }
    }
  }

  /** Execute Node.js code in a project folder */
  async executeNode(projectFolder: string, code: string, timeoutMs?: number): Promise<ExecutionResult> {
    const projectDir = this.resolveProject(projectFolder);
    const timeout = Math.min(timeoutMs || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const tempFile = path.join(projectDir, `_choom_tmp_${randomBytes(4).toString('hex')}.js`);
    const start = Date.now();

    try {
      await writeFile(tempFile, code, 'utf-8');

      return new Promise<ExecutionResult>((resolve) => {
        exec(`node "${tempFile}"`, {
          cwd: projectDir,
          timeout,
          maxBuffer: MAX_OUTPUT_BYTES * 2,
          shell: '/bin/bash',
        }, (error, stdout, stderr) => {
          const durationMs = Date.now() - start;
          const timedOut = error?.killed === true;
          const stdoutResult = this.truncateOutput(stdout || '');
          const stderrResult = this.truncateOutput(stderr || '');

          resolve({
            success: !error,
            stdout: stdoutResult.text,
            stderr: stderrResult.text,
            exitCode: error ? (error as any).code ?? 1 : 0,
            timedOut,
            truncated: stdoutResult.truncated || stderrResult.truncated,
            durationMs,
          });
        });
      });
    } finally {
      try { await unlink(tempFile); } catch { /* already cleaned */ }
    }
  }

  /** Create a Python virtual environment */
  async createPythonVenv(projectFolder: string): Promise<ExecutionResult> {
    return this.runCommand(projectFolder, 'python3 -m venv venv', 60_000);
  }

  /** Initialize a Node.js project with npm */
  async initNodeProject(projectFolder: string): Promise<ExecutionResult> {
    return this.runCommand(projectFolder, 'npm init -y', 60_000);
  }

  /** Install Python packages via pip */
  async pipInstall(projectFolder: string, packages: string[]): Promise<ExecutionResult> {
    // Validate package names (alphanumeric, hyphens, underscores, brackets for extras)
    for (const pkg of packages) {
      if (!/^[a-zA-Z0-9_\-\[\],.<>=!~]+$/.test(pkg)) {
        return {
          success: false,
          stdout: '',
          stderr: `Invalid package name: "${pkg}"`,
          exitCode: 1,
          timedOut: false,
          truncated: false,
          durationMs: 0,
        };
      }
    }
    const safePackages = packages.join(' ');
    return this.runCommand(projectFolder, `pip install ${safePackages}`, 600_000);
  }

  /** Install Node.js packages via npm */
  async npmInstall(projectFolder: string, packages: string[]): Promise<ExecutionResult> {
    // Validate package names
    for (const pkg of packages) {
      if (!/^[@a-zA-Z0-9_\-/.<>=^~]+$/.test(pkg)) {
        return {
          success: false,
          stdout: '',
          stderr: `Invalid package name: "${pkg}"`,
          exitCode: 1,
          timedOut: false,
          truncated: false,
          durationMs: 0,
        };
      }
    }
    const safePackages = packages.join(' ');
    return this.runCommand(projectFolder, `npm install ${safePackages}`, 600_000);
  }
}
