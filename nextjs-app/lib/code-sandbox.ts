/**
 * Code Sandbox Service
 * Provides sandboxed code execution for Python and Node.js within workspace project folders.
 * Uses child_process with timeout enforcement and output truncation.
 */

import { exec } from 'child_process';
import { writeFile, unlink, access } from 'fs/promises';
import path from 'path';
import { randomBytes } from 'crypto';

interface ExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 50 * 1024; // 50KB

export class CodeSandbox {
  private workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = path.resolve(workspaceRoot);
  }

  /** Resolve and validate a project folder path within the workspace */
  private resolveProject(projectFolder: string): string {
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

    return new Promise<ExecutionResult>((resolve) => {
      const proc = exec(shellCommand, {
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
    return this.runCommand(projectFolder, `pip install ${safePackages}`, 120_000);
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
    return this.runCommand(projectFolder, `npm install ${safePackages}`, 120_000);
  }
}
