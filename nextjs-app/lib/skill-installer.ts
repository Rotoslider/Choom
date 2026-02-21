/**
 * External Skill Installer
 * Downloads skills from GitHub repos, verifies safety, and installs to the
 * external skills directory with sandboxed execution context.
 */

import * as fs from 'fs';
import * as path from 'path';
import { EXTERNAL_SKILLS_ROOT } from '@/lib/config';

// ============================================================================
// Constants
// ============================================================================

// ============================================================================
// Types
// ============================================================================

export interface SkillPackage {
  name: string;
  source: string; // GitHub URL
  files: { path: string; content: string }[];
  metadata: {
    name: string;
    description: string;
    version: string;
    author: string;
    tools: string[];
  };
}

export interface VerificationReport {
  safe: boolean;
  warnings: string[];   // Non-blocking concerns
  blockers: string[];   // Blocks installation
  scannedFiles: string[];
}

interface InstalledMeta {
  source: string;
  installedAt: string;
  verificationReport: VerificationReport;
}

interface GitHubContentEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  download_url: string | null;
  content?: string;
  encoding?: string;
}

// ============================================================================
// YAML Frontmatter Parser (minimal, consistent with skill-loader.ts)
// ============================================================================

function parseYAMLFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const yamlStr = match[1];
  const body = match[2];
  const frontmatter: Record<string, unknown> = {};
  const lines = yamlStr.split('\n');
  let currentKey = '';
  let currentArray: string[] | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (trimmed.startsWith('- ') && currentArray !== null) {
      currentArray.push(trimmed.slice(2).trim());
      continue;
    }

    if (currentArray !== null) {
      frontmatter[currentKey] = currentArray;
      currentArray = null;
    }

    const kvMatch = trimmed.match(/^(\w+)\s*:\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1];
      const value = kvMatch[2].trim();
      if (value === '' || value === '[]') {
        currentKey = key;
        currentArray = [];
      } else if (value.startsWith('[') && value.endsWith(']')) {
        frontmatter[key] = value.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
      } else {
        frontmatter[key] = value.replace(/^["']|["']$/g, '');
      }
    }
  }

  if (currentArray !== null) {
    frontmatter[currentKey] = currentArray;
  }

  return { frontmatter, body };
}

// ============================================================================
// Safety Patterns
// ============================================================================

/** Patterns that block installation entirely */
const BLOCKER_PATTERNS: { pattern: RegExp; description: string }[] = [
  // Process spawning
  { pattern: /\bchild_process\b/, description: 'child_process module usage' },
  { pattern: /\bexec\s*\(/, description: 'exec() call' },
  { pattern: /\bexecSync\s*\(/, description: 'execSync() call' },
  { pattern: /\bspawn\s*\(/, description: 'spawn() call' },
  { pattern: /\bspawnSync\s*\(/, description: 'spawnSync() call' },
  { pattern: /\bexecFile\s*\(/, description: 'execFile() call' },
  { pattern: /\bexecFileSync\s*\(/, description: 'execFileSync() call' },

  // Destructive filesystem operations
  { pattern: /\bfs\s*\.\s*unlink/, description: 'fs.unlink (file deletion)' },
  { pattern: /\bfs\s*\.\s*rmdir/, description: 'fs.rmdir (directory deletion)' },
  { pattern: /\bfs\s*\.\s*rm\b/, description: 'fs.rm (recursive deletion)' },
  { pattern: /\bunlink\s*\(/, description: 'unlink() call' },
  { pattern: /\brmdir\s*\(/, description: 'rmdir() call' },
  { pattern: /rm\s+-rf\b/, description: 'rm -rf shell pattern' },
  { pattern: /rimraf/, description: 'rimraf module usage' },

  // Dynamic code execution
  { pattern: /\beval\s*\(/, description: 'eval() call' },
  { pattern: /\bnew\s+Function\s*\(/, description: 'new Function() constructor' },
  { pattern: /\bvm\s*\.\s*runIn(Context|NewContext|ThisContext)\s*\(/, description: 'vm.runInContext() usage' },
  { pattern: /\bvm\s*\.\s*compileFunction\s*\(/, description: 'vm.compileFunction() usage' },
  { pattern: /\bvm\s*\.\s*Script\b/, description: 'vm.Script usage' },

  // Process manipulation
  { pattern: /\bprocess\s*\.\s*exit\s*\(/, description: 'process.exit() call' },
  { pattern: /\bprocess\s*\.\s*kill\s*\(/, description: 'process.kill() call' },

  // Obfuscated code (base64 strings > 100 chars)
  { pattern: /["'`][A-Za-z0-9+/=]{100,}["'`]/, description: 'Suspected obfuscated code (long base64 string)' },
  // Obfuscated code (hex strings > 50 chars)
  { pattern: /["'`]\\x[0-9a-fA-F]{50,}["'`]/, description: 'Suspected obfuscated code (long hex string)' },
  { pattern: /(?:0x[0-9a-fA-F]{2},?\s*){25,}/, description: 'Suspected obfuscated code (hex byte array)' },
];

/** Patterns that generate warnings (shown to user but don't block) */
const WARNING_PATTERNS: { pattern: RegExp; description: string }[] = [
  // Network requests
  { pattern: /\bfetch\s*\(/, description: 'Network fetch() call detected' },
  { pattern: /\baxios\b/, description: 'Axios HTTP library usage' },
  { pattern: /\bhttp\s*\.\s*request/, description: 'Node.js http.request() usage' },
  { pattern: /\bhttps\s*\.\s*request/, description: 'Node.js https.request() usage' },
  { pattern: /new\s+URL\s*\(/, description: 'URL construction (possible external request)' },
  { pattern: /XMLHttpRequest/, description: 'XMLHttpRequest usage' },

  // Environment access
  { pattern: /\bprocess\s*\.\s*env\b/, description: 'process.env access (may read secrets)' },

  // Non-standard imports
  { pattern: /require\s*\(\s*['"][^./]/, description: 'Import of non-standard module via require()' },
  { pattern: /from\s+['"][^./]/, description: 'Import of non-standard module via ESM import' },

  // File write operations
  { pattern: /\bfs\s*\.\s*write/, description: 'File write operation' },
  { pattern: /\bfs\s*\.\s*appendFile/, description: 'File append operation' },
  { pattern: /\bwriteFile\s*\(/, description: 'writeFile() call' },
  { pattern: /\bwriteFileSync\s*\(/, description: 'writeFileSync() call' },
  { pattern: /\bfs\s*\.\s*mkdir/, description: 'Directory creation operation' },
  { pattern: /\bfs\s*\.\s*rename/, description: 'File rename/move operation' },
  { pattern: /\bfs\s*\.\s*copyFile/, description: 'File copy operation' },
];

// ============================================================================
// SkillInstaller Class
// ============================================================================

export class SkillInstaller {
  private externalRoot: string;

  constructor(externalRoot?: string) {
    this.externalRoot = externalRoot || EXTERNAL_SKILLS_ROOT;
  }

  // ========================================================================
  // Fetch from GitHub
  // ========================================================================

  /**
   * Fetch a skill package from a GitHub repository URL.
   * Supports formats:
   *   - https://github.com/user/repo (root of repo, uses main branch)
   *   - https://github.com/user/repo/tree/main/path/to/skill
   *   - https://github.com/user/repo/tree/branch/path/to/skill
   */
  async fetch(source: string): Promise<SkillPackage> {
    const parsed = this.parseGitHubUrl(source);
    if (!parsed) {
      throw new Error(
        `Invalid GitHub URL: "${source}". Expected format: https://github.com/owner/repo or https://github.com/owner/repo/tree/branch/path`
      );
    }

    const { owner, repo, branch, dirPath } = parsed;

    // List files in the directory via GitHub Contents API
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${dirPath}${branch ? `?ref=${branch}` : ''}`;
    const listResponse = await fetch(apiUrl, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Choom-Skill-Installer/1.0',
      },
    });

    if (!listResponse.ok) {
      const errorText = await listResponse.text();
      throw new Error(
        `GitHub API error (${listResponse.status}): ${errorText}. URL: ${apiUrl}`
      );
    }

    const entries: GitHubContentEntry[] = await listResponse.json();

    if (!Array.isArray(entries)) {
      throw new Error(
        `Expected directory listing from GitHub API, got a single file. Make sure the URL points to a directory.`
      );
    }

    // Validate required files
    const fileNames = entries.filter(e => e.type === 'file').map(e => e.name);
    const hasSkillMd = fileNames.includes('SKILL.md');
    const hasTools = fileNames.includes('tools.ts') || fileNames.includes('tools.js');
    const hasHandler = fileNames.includes('handler.ts') || fileNames.includes('handler.js');

    if (!hasSkillMd) {
      throw new Error(`Missing required file: SKILL.md in ${source}`);
    }
    if (!hasTools) {
      throw new Error(`Missing required file: tools.ts or tools.js in ${source}`);
    }
    if (!hasHandler) {
      throw new Error(`Missing required file: handler.ts or handler.js in ${source}`);
    }

    // Download all files (only files, skip subdirectories for now)
    const files: { path: string; content: string }[] = [];
    const fileEntries = entries.filter(e => e.type === 'file');

    for (const entry of fileEntries) {
      const content = await this.fetchFileContent(entry, owner, repo, branch);
      files.push({ path: entry.name, content });
    }

    // Parse SKILL.md frontmatter for metadata
    const skillMdFile = files.find(f => f.path === 'SKILL.md');
    if (!skillMdFile) {
      throw new Error('SKILL.md file was listed but could not be downloaded');
    }

    const { frontmatter } = parseYAMLFrontmatter(skillMdFile.content);

    const metadata = {
      name: (frontmatter.name as string) || this.inferNameFromUrl(source),
      description: (frontmatter.description as string) || '',
      version: (frontmatter.version as string) || '1.0.0',
      author: (frontmatter.author as string) || 'unknown',
      tools: (frontmatter.tools as string[]) || [],
    };

    if (!metadata.name) {
      throw new Error('Could not determine skill name from SKILL.md frontmatter or URL');
    }

    return {
      name: metadata.name,
      source,
      files,
      metadata,
    };
  }

  /**
   * Parse a GitHub URL into its components.
   * Returns null if the URL is not a valid GitHub URL.
   */
  private parseGitHubUrl(url: string): { owner: string; repo: string; branch: string; dirPath: string } | null {
    try {
      const parsed = new URL(url);
      if (parsed.hostname !== 'github.com') return null;

      // Remove leading slash and split
      const parts = parsed.pathname.replace(/^\//, '').replace(/\/$/, '').split('/');

      if (parts.length < 2) return null;

      const owner = parts[0];
      const repo = parts[1].replace(/\.git$/, '');

      // Simple repo URL: github.com/owner/repo
      if (parts.length === 2) {
        return { owner, repo, branch: 'main', dirPath: '' };
      }

      // Tree URL: github.com/owner/repo/tree/branch/path/to/dir
      if (parts[2] === 'tree' && parts.length >= 4) {
        const branch = parts[3];
        const dirPath = parts.slice(4).join('/');
        return { owner, repo, branch, dirPath };
      }

      // Blob URL: github.com/owner/repo/blob/branch/path — not valid for skills
      if (parts[2] === 'blob') {
        return null;
      }

      // Fallback: treat extra segments as path on main branch
      return { owner, repo, branch: 'main', dirPath: parts.slice(2).join('/') };
    } catch {
      return null;
    }
  }

  /**
   * Fetch the content of a single file from the GitHub API response.
   * Uses download_url for direct download, or decodes base64 content inline.
   */
  private async fetchFileContent(
    entry: GitHubContentEntry,
    owner: string,
    repo: string,
    branch: string
  ): Promise<string> {
    // If the content is already embedded (small files), decode it
    if (entry.content && entry.encoding === 'base64') {
      return Buffer.from(entry.content, 'base64').toString('utf-8');
    }

    // Otherwise fetch from the raw content URL
    if (entry.download_url) {
      const response = await fetch(entry.download_url, {
        headers: { 'User-Agent': 'Choom-Skill-Installer/1.0' },
      });
      if (!response.ok) {
        throw new Error(`Failed to download ${entry.name}: HTTP ${response.status}`);
      }
      return await response.text();
    }

    // Fallback: use the individual file contents API
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${entry.path}${branch ? `?ref=${branch}` : ''}`;
    const response = await fetch(apiUrl, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Choom-Skill-Installer/1.0',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch ${entry.name} via API: HTTP ${response.status}`);
    }

    const data = await response.json();
    if (data.content && data.encoding === 'base64') {
      return Buffer.from(data.content, 'base64').toString('utf-8');
    }

    throw new Error(`Unable to retrieve content for ${entry.name}`);
  }

  /**
   * Infer a skill name from the GitHub URL (last path segment).
   */
  private inferNameFromUrl(url: string): string {
    try {
      const parsed = new URL(url);
      const parts = parsed.pathname.replace(/^\//, '').replace(/\/$/, '').split('/');
      // Use last meaningful segment
      const last = parts[parts.length - 1] || parts[parts.length - 2] || 'unnamed-skill';
      return last.toLowerCase().replace(/[^a-z0-9-_]/g, '-');
    } catch {
      return 'unnamed-skill';
    }
  }

  // ========================================================================
  // Safety Verification
  // ========================================================================

  /**
   * Scan a skill package for dangerous patterns.
   * Returns a verification report with blockers (prevent install) and warnings (inform user).
   */
  verify(pkg: SkillPackage): VerificationReport {
    const warnings: string[] = [];
    const blockers: string[] = [];
    const scannedFiles: string[] = [];

    for (const file of pkg.files) {
      // Only scan code files
      const ext = path.extname(file.path).toLowerCase();
      const codeExtensions = ['.ts', '.js', '.mjs', '.cjs', '.tsx', '.jsx'];
      if (!codeExtensions.includes(ext)) continue;

      scannedFiles.push(file.path);
      const content = file.content;

      // Check for blockers
      for (const { pattern, description } of BLOCKER_PATTERNS) {
        if (pattern.test(content)) {
          blockers.push(`[${file.path}] ${description}`);
        }
      }

      // Check for warnings
      for (const { pattern, description } of WARNING_PATTERNS) {
        if (pattern.test(content)) {
          warnings.push(`[${file.path}] ${description}`);
        }
      }
    }

    // Deduplicate
    const uniqueBlockers = Array.from(new Set(blockers));
    const uniqueWarnings = Array.from(new Set(warnings));

    return {
      safe: uniqueBlockers.length === 0,
      warnings: uniqueWarnings,
      blockers: uniqueBlockers,
      scannedFiles,
    };
  }

  // ========================================================================
  // Install
  // ========================================================================

  /**
   * Install a verified skill package to the external skills directory.
   * Creates: <WORKSPACE_ROOT>/.choom-external-skills/<name>/
   * Also writes .installed.json with source, timestamp, and verification report.
   */
  async install(pkg: SkillPackage): Promise<void> {
    const skillName = pkg.metadata.name;

    // Validate skill name to prevent path traversal
    if (!skillName || /[/\\]/.test(skillName) || skillName.includes('..')) {
      throw new Error(`Invalid skill name: "${skillName}"`);
    }

    const skillDir = path.join(this.externalRoot, skillName);
    const resolvedDir = path.resolve(skillDir);

    // Ensure resolved path is within the external skills root
    if (!resolvedDir.startsWith(path.resolve(this.externalRoot))) {
      throw new Error(`Path traversal blocked: skill directory resolves outside external skills root`);
    }

    // Create the skill directory
    fs.mkdirSync(resolvedDir, { recursive: true });

    // Create the data subdirectory (sandboxed workspace for the skill)
    fs.mkdirSync(path.join(resolvedDir, 'data'), { recursive: true });

    // Write all files
    for (const file of pkg.files) {
      // Validate each file path
      const filePath = path.join(resolvedDir, file.path);
      const resolvedFile = path.resolve(filePath);
      if (!resolvedFile.startsWith(resolvedDir)) {
        throw new Error(`Path traversal blocked in file: "${file.path}"`);
      }

      // Ensure parent directory exists (for nested files)
      fs.mkdirSync(path.dirname(resolvedFile), { recursive: true });
      fs.writeFileSync(resolvedFile, file.content, 'utf-8');
    }

    // Run verification for the install metadata
    const report = this.verify(pkg);

    // Write installation metadata
    const installMeta: InstalledMeta = {
      source: pkg.source,
      installedAt: new Date().toISOString(),
      verificationReport: report,
    };

    fs.writeFileSync(
      path.join(resolvedDir, '.installed.json'),
      JSON.stringify(installMeta, null, 2),
      'utf-8'
    );

    console.log(`[SkillInstaller] Installed external skill "${skillName}" to ${resolvedDir}`);
  }

  // ========================================================================
  // Uninstall
  // ========================================================================

  /**
   * Uninstall an external skill by removing its directory.
   */
  async uninstall(skillName: string): Promise<void> {
    // Validate skill name
    if (!skillName || /[/\\]/.test(skillName) || skillName.includes('..')) {
      throw new Error(`Invalid skill name: "${skillName}"`);
    }

    const skillDir = path.join(this.externalRoot, skillName);
    const resolvedDir = path.resolve(skillDir);

    // Ensure resolved path is within the external skills root
    if (!resolvedDir.startsWith(path.resolve(this.externalRoot))) {
      throw new Error(`Path traversal blocked: skill directory resolves outside external skills root`);
    }

    if (!fs.existsSync(resolvedDir)) {
      throw new Error(`External skill "${skillName}" is not installed`);
    }

    // Verify it has .installed.json (only uninstall skills we installed)
    const metaPath = path.join(resolvedDir, '.installed.json');
    if (!fs.existsSync(metaPath)) {
      throw new Error(`"${skillName}" does not appear to be an installed external skill (missing .installed.json)`);
    }

    // Remove the directory recursively
    fs.rmSync(resolvedDir, { recursive: true, force: true });

    console.log(`[SkillInstaller] Uninstalled external skill "${skillName}"`);
  }

  // ========================================================================
  // Utility
  // ========================================================================

  /**
   * List all installed external skills.
   */
  listInstalled(): { name: string; source: string; installedAt: string }[] {
    const results: { name: string; source: string; installedAt: string }[] = [];

    if (!fs.existsSync(this.externalRoot)) return results;

    const entries = fs.readdirSync(this.externalRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const metaPath = path.join(this.externalRoot, entry.name, '.installed.json');
      if (!fs.existsSync(metaPath)) continue;

      try {
        const meta: InstalledMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        results.push({
          name: entry.name,
          source: meta.source,
          installedAt: meta.installedAt,
        });
      } catch {
        // Corrupted metadata — skip
      }
    }

    return results;
  }

  /**
   * Get the installation metadata for a specific skill.
   */
  getInstalledMeta(skillName: string): InstalledMeta | null {
    const metaPath = path.join(this.externalRoot, skillName, '.installed.json');
    if (!fs.existsSync(metaPath)) return null;

    try {
      return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    } catch {
      return null;
    }
  }

  /**
   * Get the external skills root directory path.
   */
  getExternalRoot(): string {
    return this.externalRoot;
  }
}
