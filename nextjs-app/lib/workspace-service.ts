/**
 * Workspace Service
 * Provides sandboxed file operations for the agentic tool loop.
 * Path traversal prevention, extension validation, and size limits.
 */

import { readFile, writeFile, mkdir, readdir, stat, unlink, realpath } from 'fs/promises';
import { readdirSync, readFileSync } from 'fs';
import { exec } from 'child_process';
import path from 'path';
import { buildSandboxEnv } from './sandbox-env';

interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
  /** Last modification time (ms since epoch); files only. */
  mtimeMs?: number;
}

export class WorkspaceService {
  private rootPath: string;
  private realRootPath: string | null = null;
  private maxFileSizeKB: number;
  private allowedExtensions: string[];

  constructor(rootPath: string, maxFileSizeKB: number, allowedExtensions: string[]) {
    this.rootPath = path.resolve(rootPath);
    this.maxFileSizeKB = maxFileSizeKB;
    this.allowedExtensions = allowedExtensions;
  }

  /**
   * The workspace root with symlinks resolved, memoized.
   *
   * path.resolve() normalises "..", but does not follow symlinks. macOS reaches
   * several ordinary directories through them — /tmp -> /private/tmp,
   * /var -> /private/var, so os.tmpdir() is "/var/folders/..." whose realpath is
   * "/private/var/folders/..." — and the containment checks below compare
   * realpath()'d file paths. Comparing those against an unresolved root rejects
   * every write under such a root as symlink traversal.
   */
  private async getRealRoot(): Promise<string> {
    if (this.realRootPath === null) {
      try {
        this.realRootPath = await realpath(this.rootPath);
      } catch {
        this.realRootPath = this.rootPath; // not created yet — nothing to resolve
      }
    }
    return this.realRootPath;
  }

  /**
   * Assert an already-realpath()'d path lies inside the workspace.
   * The trailing separator matters: a bare startsWith() also accepts a sibling
   * that merely shares the root as a string prefix ("<root>-evil").
   */
  private async assertInsideRoot(realPath: string): Promise<boolean> {
    const root = await this.getRealRoot();
    return realPath === root || realPath.startsWith(root + path.sep);
  }

  /**
   * Resolve a relative path safely within the workspace root.
   * Prevents path traversal attacks (../, symlinks outside root).
   */
  resolveSafe(relativePath: string): string {
    // Decode URL-encoded characters (LLMs sometimes encode spaces as %20)
    let cleaned: string;
    try {
      cleaned = decodeURIComponent(relativePath);
    } catch {
      // Invalid percent-encoding (e.g., "file%_name") — strip malformed % sequences
      cleaned = relativePath.replace(/%(?![0-9A-Fa-f]{2})/g, '');
    }

    // Absolute paths that already point INSIDE the workspace must be rebased,
    // not slash-stripped. Tools routinely hand the model an absolute path (image
    // paths, download targets, FreeCAD exports) and the model hands it straight
    // back. Blindly dropping the leading slash turned
    //   /home/nuc1/choom-projects/freecad/view.png
    // into
    //   /home/nuc1/choom-projects/home/nuc1/choom-projects/freecad/view.png
    // which is the single largest source of ENOENT ('path'-class) errors in the
    // trace corpus. Rebase here, before any other munging.
    if (path.isAbsolute(cleaned)) {
      const abs = path.resolve(cleaned);
      if (abs === this.rootPath || abs.startsWith(this.rootPath + path.sep)) {
        cleaned = path.relative(this.rootPath, abs) || '.';
      }
      // Otherwise fall through to the leading-slash strip below, which treats
      // it as workspace-relative.
      //
      // Do NOT "helpfully" throw here. A leading slash on a workspace path is
      // overwhelmingly a Choom writing "/choom_commons/for_eve/note.md" when it
      // means "choom_commons/for_eve/note.md" — replaying every path argument in
      // data/traces through this function, 24 distinct real paths take this
      // branch and all 24 are genuine workspace folders (/choom_commons/...,
      // /selfies_aloy/..., /uploads/...). Rejecting them breaks cross-Choom
      // letters, camera snapshots and uploads.
      //
      // Nothing escapes: the strip makes it relative, and the containment check
      // at the end of this function still blocks real traversal ("../../etc",
      // or a sibling dir sharing the root as a string prefix). A true system
      // path like "/etc/passwd" simply resolves to <root>/etc/passwd and fails
      // as not-found, which is contained and safe.
    }

    // Strip characters that are never valid in file paths.
    // Allow: alphanumeric, hyphen, underscore, dot, forward slash, space, parentheses
    const sanitized = cleaned.replace(/[^a-zA-Z0-9\-_./\s()]/g, '');
    if (sanitized !== cleaned) {
      console.warn(`   ⚠️ Path sanitized: "${relativePath}" → "${sanitized}"`);
      cleaned = sanitized;
    }

    // Collapse multiple consecutive slashes or spaces, trim spaces around slashes
    cleaned = cleaned.replace(/\/{2,}/g, '/').replace(/\s*\/\s*/g, '/').replace(/\s{2,}/g, '_');

    // Strip leading slashes to prevent absolute path injection
    cleaned = cleaned.replace(/^[/\\]+/, '');

    // Trim each path segment — trailing spaces break extension detection (".py " ≠ ".py")
    cleaned = cleaned.split('/').map(s => s.trim()).filter(Boolean).join('/');

    // Case-insensitive + fuzzy top-folder matching: redirect to the canonical project folder.
    // Prevents LLMs creating duplicates like "my_photos" vs "My_Photos" or typos
    // like "local_model._development" vs "local_model_development".
    // When multiple case variants exist, prefer the one with maxIterations in metadata
    // (user-configured), then fall back to the one with more files (the real project).
    const segments = cleaned.split(/[/\\]/);
    if (segments.length > 0 && segments[0]) {
      try {
        const existing = readdirSync(this.rootPath);
        // Exact case-insensitive match first
        let ciMatches = existing.filter(e => e.toLowerCase() === segments[0].toLowerCase());
        // Fuzzy match: strip non-alphanumeric and compare (catches typos like extra dots/underscores)
        if (ciMatches.length === 0) {
          const normalize = (s: string) => s.replace(/[^a-z0-9]/gi, '').toLowerCase();
          const targetNorm = normalize(segments[0]);
          if (targetNorm.length >= 3) { // avoid matching on very short strings
            ciMatches = existing.filter(e => normalize(e) === targetNorm);
            if (ciMatches.length > 0) {
              console.warn(`   ⚠️ Fuzzy folder match: "${segments[0]}" → "${ciMatches[0]}"`);
            }
          }
        }

        // Room-slug redirect: Chooms know a group room by its bare slug —
        // it's the `room` arg of talk_with_sisters and what list_my_rooms
        // shows — but the folder lives at choom_commons/rooms/<slug>. A
        // bare-slug path used to resolve at the workspace ROOT, where the
        // auto-mkdir write silently created a duplicate room tree
        // (2026-08-06: Edyta wrote the D1 power-up protocol into a phantom
        // root copy, then Optic "reorganized" inside the same phantom).
        // Only fires when nothing at the root matched, so an intentional
        // root project can never be shadowed by a room.
        if (ciMatches.length === 0) {
          try {
            const roomsRel = path.join('choom_commons', 'rooms');
            const roomDirs = readdirSync(path.join(this.rootPath, roomsRel));
            const normalize = (s: string) => s.replace(/[^a-z0-9]/gi, '').toLowerCase();
            const room = roomDirs.find(r => r.toLowerCase() === segments[0].toLowerCase())
              || (normalize(segments[0]).length >= 3
                ? roomDirs.find(r => normalize(r) === normalize(segments[0]))
                : undefined);
            if (room) {
              console.warn(`   ⚠️ Room-slug path redirect: "${segments[0]}" → "choom_commons/rooms/${room}"`);
              segments.splice(0, 1, 'choom_commons', 'rooms', room);
              cleaned = segments.join('/');
            }
          } catch { /* no rooms dir yet — nothing to redirect to */ }
        }

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

    // Separator-aware containment check. A bare startsWith() would accept
    // "/home/nuc1/choom-projects-evil" for root "/home/nuc1/choom-projects",
    // since the root is a string prefix of the sibling directory.
    if (resolved !== this.rootPath && !resolved.startsWith(this.rootPath + path.sep)) {
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
    if (!(await this.assertInsideRoot(realWrittenPath))) {
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
    if (!(await this.assertInsideRoot(realWrittenPath))) {
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
    if (!(await this.assertInsideRoot(realFilePath))) {
      throw new Error(`Symlink traversal blocked: file resolves outside workspace`);
    }

    return await readFile(fullPath, 'utf-8');
  }

  /** List files in a workspace directory */
  /** Does this workspace-relative path exist as a directory? */
  async directoryExists(relativePath: string): Promise<boolean> {
    try {
      const st = await stat(this.resolveSafe(relativePath || '.'));
      return st.isDirectory();
    } catch {
      return false;
    }
  }

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
          results.push({ name: entry.name, type: 'file', size: stats.size, mtimeMs: stats.mtimeMs });
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

  /**
   * Recursively list a directory tree (files AND folders), returning root-
   * relative paths (directly usable in read/write tools). A plain one-level list
   * hides files that live in
   * subfolders — so a Choom that earlier made `journals/journal.md` lists the
   * folder, doesn't see the file, and creates a duplicate. This surfaces the
   * whole tree (capped) so existing files are found. Depth- and count-bounded to
   * keep the result token-cheap.
   */
  async listFilesRecursive(
    relativePath: string = '',
    maxDepth: number = 4,
    maxEntries: number = 300,
  ): Promise<{
    entries: Array<{ path: string; type: 'file' | 'directory'; size: number; children?: number; mtimeMs?: number }>;
    truncated: boolean;
    /** The most recently modified files seen anywhere in the walk, newest first (up to 5). */
    newest: Array<{ path: string; mtimeMs: number }>;
  }> {
    type Entry = { path: string; type: 'file' | 'directory'; size: number; children?: number; mtimeMs?: number };
    const out: Entry[] = [];
    const seenFiles: Array<{ path: string; mtimeMs: number }> = [];
    let truncated = false;
    // Below the listing cut-off, still look for the newest files (bounded):
    // a one-level root map would otherwise never know that yesterday's image
    // is three folders down.
    let scanBudget = 3000;
    const scanNewest = async (absRel: string, depthLeft: number): Promise<void> => {
      if (depthLeft <= 0 || scanBudget <= 0) return;
      let entries: FileEntry[];
      try { entries = await this.listFiles(absRel); } catch { return; }
      for (const e of entries) {
        if (scanBudget-- <= 0) return;
        const childAbs = `${absRel}/${e.name}`;
        if (e.type === 'file' && typeof e.mtimeMs === 'number') seenFiles.push({ path: childAbs, mtimeMs: e.mtimeMs });
        else if (e.type === 'directory') await scanNewest(childAbs, depthLeft - 1);
      }
    };
    const countInside = async (entry: Entry, childAbs: string) => {
      // Say how much is inside instead of hiding it — a folder of 400 selfies
      // reads as "(400 inside)" rather than as empty.
      try { entry.children = (await this.listFiles(childAbs)).length; } catch { /* unreadable: leave undefined */ }
      await scanNewest(childAbs, 3);
    };
    const walk = async (absRel: string, depth: number): Promise<void> => {
      let entries: FileEntry[];
      try { entries = await this.listFiles(absRel); } catch { return; }
      for (const e of entries) {
        // Root-relative path → directly usable in read/write tools, no ambiguity
        // about which folder it lives in.
        const childAbs = absRel ? `${absRel}/${e.name}` : e.name;
        if (e.type === 'file' && typeof e.mtimeMs === 'number') seenFiles.push({ path: childAbs, mtimeMs: e.mtimeMs });
        if (out.length >= maxEntries) {
          // Past the cap: FOLDERS still get a line (with a count) so the map
          // stays complete — files are what overflowed it. Previously the cap
          // fell mid-alphabet and `images/` never appeared under a folder whose
          // camera snapshots came first (DeepSeek opened four subfolders one by
          // one hunting for it, 2026-09-12).
          if (e.type === 'directory') {
            const entry: Entry = { path: childAbs, type: 'directory', size: 0 };
            await countInside(entry, childAbs);
            out.push(entry);
          }
          truncated = true;
          continue;
        }
        const entry: Entry = { path: childAbs, type: e.type, size: e.size, ...(e.mtimeMs !== undefined && { mtimeMs: e.mtimeMs }) };
        out.push(entry);
        if (e.type === 'directory') {
          if (depth < maxDepth) {
            await walk(childAbs, depth + 1);
          } else {
            await countInside(entry, childAbs);
          }
        }
      }
    };
    await walk(relativePath, 1);
    const newest = seenFiles.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 5);
    return { entries: out, truncated, newest };
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
    if (!(await this.assertInsideRoot(realFilePath))) {
      throw new Error(`Symlink traversal blocked: file resolves outside workspace`);
    }

    return new Promise<string>((resolve, reject) => {
      let pageArgs = '';
      if (pages?.start) pageArgs += ` -f ${pages.start}`;
      if (pages?.end) pageArgs += ` -l ${pages.end}`;

      exec(`pdftotext${pageArgs} -layout "${fullPath}" -`, {
        maxBuffer: 5 * 1024 * 1024, // 5MB text output limit
        timeout: 30000,
        // Defense in depth (C-48): pdftotext parses an UNTRUSTED file and
        // needs no credentials. Don't hand it the app's secrets.
        env: buildSandboxEnv(),
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
    if (!(await this.assertInsideRoot(realFilePath))) {
      throw new Error(`Symlink traversal blocked: file resolves outside workspace`);
    }

    return await readFile(fullPath);
  }

  /** Delete a file from the workspace */
  async deleteFile(relativePath: string): Promise<void> {
    const fullPath = this.resolveSafe(relativePath);

    // Verify real path is within workspace
    const realFilePath = await realpath(fullPath);
    if (!(await this.assertInsideRoot(realFilePath))) {
      throw new Error(`Symlink traversal blocked: file resolves outside workspace`);
    }

    await unlink(fullPath);
  }
}
