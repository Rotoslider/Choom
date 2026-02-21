/**
 * Workspace Service
 * Provides sandboxed file operations for the agentic tool loop.
 * Path traversal prevention, extension validation, and size limits.
 */

import { readFile, writeFile, mkdir, readdir, stat, unlink, realpath } from 'fs/promises';
import { readdirSync, readFileSync } from 'fs';
import { exec } from 'child_process';
import path from 'path';

interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
}

export class WorkspaceService {
  private rootPath: string;
  private maxFileSizeKB: number;
  private allowedExtensions: string[];

  constructor(rootPath: string, maxFileSizeKB: number, allowedExtensions: string[]) {
    this.rootPath = path.resolve(rootPath);
    this.maxFileSizeKB = maxFileSizeKB;
    this.allowedExtensions = allowedExtensions;
  }

  /**
   * Resolve a relative path safely within the workspace root.
   * Prevents path traversal attacks (../, symlinks outside root).
   */
  resolveSafe(relativePath: string): string {
    // Decode URL-encoded characters (LLMs sometimes encode spaces as %20)
    let cleaned = decodeURIComponent(relativePath);
    // Strip leading slashes to prevent absolute path injection
    cleaned = cleaned.replace(/^[/\\]+/, '');

    // Case-insensitive top-folder matching: redirect to the canonical project folder.
    // Prevents LLMs creating duplicates like "my_photos" vs "My_Photos".
    // When multiple case variants exist, prefer the one with maxIterations in metadata
    // (user-configured), then fall back to the one with more files (the real project).
    const segments = cleaned.split(/[/\\]/);
    if (segments.length > 0 && segments[0]) {
      try {
        const existing = readdirSync(this.rootPath);
        const ciMatches = existing.filter(e => e.toLowerCase() === segments[0].toLowerCase());

        if (ciMatches.length === 1) {
          // Single match — use it regardless of casing
          segments[0] = ciMatches[0];
          cleaned = segments.join('/');
        } else if (ciMatches.length > 1) {
          // Multiple case variants — pick the canonical one
          let best: string | null = null;

          // Prefer the one with maxIterations in project metadata (user-configured)
          for (const d of ciMatches) {
            try {
              const meta = JSON.parse(readFileSync(path.join(this.rootPath, d, '.choom-project.json'), 'utf-8'));
              if (meta.maxIterations) { best = d; break; }
            } catch { /* no metadata */ }
          }

          // Fallback: prefer the one with more files (the real project, not the stale duplicate)
          if (!best) {
            let maxCount = -1;
            for (const d of ciMatches) {
              try {
                const count = readdirSync(path.join(this.rootPath, d)).length;
                if (count > maxCount) { maxCount = count; best = d; }
              } catch { /* ignore */ }
            }
          }

          if (best) {
            segments[0] = best;
            cleaned = segments.join('/');
          }
        }
      } catch { /* rootPath may not exist yet */ }
    }

    const resolved = path.resolve(this.rootPath, cleaned);

    if (!resolved.startsWith(this.rootPath)) {
      throw new Error(`Path traversal blocked: "${relativePath}" resolves outside workspace`);
    }

    return resolved;
  }

  /** Ensure workspace root directory exists */
  async ensureRoot(): Promise<void> {
    await mkdir(this.rootPath, { recursive: true });
  }

  /** Create a folder in the workspace */
  async createFolder(relativePath: string): Promise<string> {
    const fullPath = this.resolveSafe(relativePath);
    await this.ensureRoot();
    await mkdir(fullPath, { recursive: true });
    return `Created folder: ${relativePath}`;
  }

  /** Write a file to the workspace with extension and size validation */
  async writeFile(relativePath: string, content: string): Promise<string> {
    const fullPath = this.resolveSafe(relativePath);
    const ext = path.extname(fullPath).toLowerCase();

    if (!this.allowedExtensions.includes(ext)) {
      throw new Error(`Extension "${ext}" not allowed. Allowed: ${this.allowedExtensions.join(', ')}`);
    }

    const sizeKB = Buffer.byteLength(content, 'utf-8') / 1024;
    if (sizeKB > this.maxFileSizeKB) {
      throw new Error(`File too large (${sizeKB.toFixed(1)}KB). Maximum: ${this.maxFileSizeKB}KB`);
    }

    await this.ensureRoot();
    // Ensure parent directory exists
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, 'utf-8');

    // Verify the written file is still within workspace (symlink check)
    const realWrittenPath = await realpath(fullPath);
    if (!realWrittenPath.startsWith(this.rootPath)) {
      await unlink(fullPath);
      throw new Error(`Symlink traversal blocked: file resolves outside workspace`);
    }

    return `Wrote ${relativePath} (${sizeKB.toFixed(1)}KB)`;
  }

  /** Write a binary buffer to the workspace (for images, PDFs, etc.) */
  async writeFileBuffer(relativePath: string, buffer: Buffer, allowedExtensions?: string[]): Promise<string> {
    const fullPath = this.resolveSafe(relativePath);
    const ext = path.extname(fullPath).toLowerCase();
    const exts = allowedExtensions || this.allowedExtensions;

    if (!exts.includes(ext)) {
      throw new Error(`Extension "${ext}" not allowed. Allowed: ${exts.join(', ')}`);
    }

    const sizeKB = buffer.length / 1024;
    if (sizeKB > this.maxFileSizeKB) {
      throw new Error(`File too large (${sizeKB.toFixed(1)}KB). Maximum: ${this.maxFileSizeKB}KB`);
    }

    await this.ensureRoot();
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, buffer);

    const realWrittenPath = await realpath(fullPath);
    if (!realWrittenPath.startsWith(this.rootPath)) {
      await unlink(fullPath);
      throw new Error(`Symlink traversal blocked: file resolves outside workspace`);
    }

    return `Wrote ${relativePath} (${sizeKB.toFixed(1)}KB)`;
  }

  /** Read a file from the workspace */
  async readFile(relativePath: string): Promise<string> {
    const fullPath = this.resolveSafe(relativePath);

    // Verify real path is within workspace
    const realFilePath = await realpath(fullPath);
    if (!realFilePath.startsWith(this.rootPath)) {
      throw new Error(`Symlink traversal blocked: file resolves outside workspace`);
    }

    return await readFile(fullPath, 'utf-8');
  }

  /** List files in a workspace directory */
  async listFiles(relativePath: string = ''): Promise<FileEntry[]> {
    const fullPath = this.resolveSafe(relativePath || '.');
    await this.ensureRoot();

    try {
      const entries = await readdir(fullPath, { withFileTypes: true });
      const results: FileEntry[] = [];

      for (const entry of entries) {
        const entryPath = path.join(fullPath, entry.name);
        if (entry.isDirectory()) {
          results.push({ name: entry.name, type: 'directory', size: 0 });
        } else if (entry.isFile()) {
          const stats = await stat(entryPath);
          results.push({ name: entry.name, type: 'file', size: stats.size });
        }
      }

      return results.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }

  /** Extract text from a PDF file using pdftotext */
  async readPdfText(relativePath: string, pages?: { start?: number; end?: number }): Promise<string> {
    const fullPath = this.resolveSafe(relativePath);
    const ext = path.extname(fullPath).toLowerCase();
    if (ext !== '.pdf') {
      throw new Error(`Not a PDF file: ${relativePath}`);
    }

    // Verify real path is within workspace
    const realFilePath = await realpath(fullPath);
    if (!realFilePath.startsWith(this.rootPath)) {
      throw new Error(`Symlink traversal blocked: file resolves outside workspace`);
    }

    return new Promise<string>((resolve, reject) => {
      let pageArgs = '';
      if (pages?.start) pageArgs += ` -f ${pages.start}`;
      if (pages?.end) pageArgs += ` -l ${pages.end}`;

      exec(`pdftotext${pageArgs} -layout "${fullPath}" -`, {
        maxBuffer: 5 * 1024 * 1024, // 5MB text output limit
        timeout: 30000,
      }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`PDF text extraction failed: ${stderr || error.message}`));
          return;
        }
        const text = stdout.trim();
        if (!text) {
          resolve('(PDF contains no extractable text — may be image-based/scanned)');
          return;
        }
        // Truncate if very long
        if (text.length > 100000) {
          resolve(text.slice(0, 100000) + `\n\n... [truncated — ${text.length} total chars, use page range for specific sections]`);
        } else {
          resolve(text);
        }
      });
    });
  }

  /** Read a file as a Buffer (for binary image reads) */
  async readFileBuffer(relativePath: string): Promise<Buffer> {
    const fullPath = this.resolveSafe(relativePath);

    // Verify real path is within workspace
    const realFilePath = await realpath(fullPath);
    if (!realFilePath.startsWith(this.rootPath)) {
      throw new Error(`Symlink traversal blocked: file resolves outside workspace`);
    }

    return await readFile(fullPath);
  }

  /** Delete a file from the workspace */
  async deleteFile(relativePath: string): Promise<void> {
    const fullPath = this.resolveSafe(relativePath);

    // Verify real path is within workspace
    const realFilePath = await realpath(fullPath);
    if (!realFilePath.startsWith(this.rootPath)) {
      throw new Error(`Symlink traversal blocked: file resolves outside workspace`);
    }

    await unlink(fullPath);
  }
}
