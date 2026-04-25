// Claim Verifier
// When a delegate Choom returns a "Files Created" list to its orchestrator,
// the orchestrator currently trusts the report. Real-world failure: Genesis
// said she'd created PDFs and images; only research markdown actually
// existed; Eve relayed the claim to Donny without checking.
//
// This module extracts specific filename claims from a delegate's response
// and cross-checks them against the actual contents of the worker's project
// folder. Claims that don't exist on disk get surfaced to the orchestrator.

import * as path from 'path';
import * as fs from 'fs/promises';

export interface ClaimVerification {
  /** Filenames the delegate claimed to have created that DO exist on disk */
  verified: string[];
  /** Filenames the delegate claimed to have created that DO NOT exist on disk */
  missing: string[];
  /** True when at least one claim was found in the response text */
  hadClaims: boolean;
}

/**
 * Conservative content extensions we'll fingerprint as "file claims" when the
 * delegate's text mentions them. Skip ambiguous extensions (.c, .h are too
 * common in research notes mentioning github.com, c++ etc).
 */
const CLAIM_EXTENSIONS = new Set([
  'md', 'txt', 'json', 'jsonl', 'py', 'ts', 'tsx', 'js', 'jsx',
  'html', 'css', 'csv', 'tsv', 'sh', 'bash', 'yaml', 'yml',
  'xml', 'sql', 'toml', 'ini', 'cfg', 'r', 'ipynb', 'log',
  'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
  'wav', 'mp3', 'mp4', 'stl', 'obj',
]);

/**
 * Extract filename claims from a delegate's response. Conservative — only
 * matches filenames that appear in unambiguous "I created this" contexts:
 *   - **bold filename**
 *   - `code filename`
 *   - bullets in a "Files Created/Written:" section
 *   - "saved to FILENAME", "wrote FILENAME", "created FILENAME"
 *
 * Returns lowercased basenames (foo.md), deduplicated.
 */
export function extractFilenameClaims(text: string): string[] {
  if (!text) return [];

  const claims = new Set<string>();
  const filenameRe = /([A-Za-z0-9_\-./]+\.([A-Za-z0-9]+))(?=\b|[\s)`*"'.,])/g;

  // Generic file-shaped tokens — but only count them when in a confident context.
  // We do this by filtering on extension membership and on surrounding context.

  // Markdown bold: **filename.ext**
  const boldRe = /\*\*\s*([A-Za-z0-9_\-./]+\.[A-Za-z0-9]+)\s*\*\*/g;
  for (const m of text.matchAll(boldRe)) {
    addClaim(claims, m[1]);
  }

  // Inline code: `filename.ext`
  const codeRe = /`([A-Za-z0-9_\-./]+\.[A-Za-z0-9]+)`/g;
  for (const m of text.matchAll(codeRe)) {
    addClaim(claims, m[1]);
  }

  // Verb + filename: "saved to X", "wrote X", "created X", "writing X"
  const verbRe = /\b(?:saved\s+(?:it\s+)?to|wrote|writing|created|generated|produced|output(?:\s+to)?)\s+(?:["'`]?)([A-Za-z0-9_\-./]+\.[A-Za-z0-9]+)/gi;
  for (const m of text.matchAll(verbRe)) {
    addClaim(claims, m[1]);
  }

  // "Files Created:" / "Files Written:" section — pick up bulleted/numbered
  // file names within ~600 chars of the heading.
  const sectionRe = /(?:files\s+(?:created|written|saved)|created\s+files?|written\s+files?)[:\-]?\s*\n([\s\S]{1,600})/gi;
  for (const m of text.matchAll(sectionRe)) {
    const block = m[1];
    for (const fm of block.matchAll(filenameRe)) {
      addClaim(claims, fm[1]);
    }
  }

  return [...claims];
}

function addClaim(set: Set<string>, raw: string) {
  if (!raw) return;
  // Strip directory components — we'll match on basename against actual files
  const base = raw.split(/[/\\]/).pop() || raw;
  const ext = (base.split('.').pop() || '').toLowerCase();
  if (!CLAIM_EXTENSIONS.has(ext)) return;
  // Filter obviously bogus matches
  if (base.length > 120) return;
  if (/[<>|]/.test(base)) return;
  set.add(base.toLowerCase());
}

/**
 * Recursively list all files (basenames) under a project folder. Capped depth
 * and entry count to keep verification cheap. Returns lowercased basenames.
 */
async function listProjectFilesShallow(
  workspaceRoot: string,
  projectFolder: string,
): Promise<Set<string>> {
  const seen = new Set<string>();
  const root = path.resolve(workspaceRoot, projectFolder.replace(/^[/\\]+/, ''));
  // Sandbox: refuse anything outside the workspace
  if (!root.startsWith(path.resolve(workspaceRoot))) return seen;

  const MAX_ENTRIES = 2000;
  const MAX_DEPTH = 4;
  let count = 0;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || count >= MAX_ENTRIES) return;
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (count >= MAX_ENTRIES) return;
      if (e.name.startsWith('.')) continue; // skip dotfiles/dirs
      count++;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full, depth + 1);
      } else if (e.isFile()) {
        seen.add(e.name.toLowerCase());
      }
    }
  }

  await walk(root, 0);
  return seen;
}

/**
 * Cross-check the delegate's response claims against the actual project
 * folder contents. Returns null if there's nothing to verify (no project
 * folder, or no claims found in the response).
 */
export async function verifyDelegationClaims(opts: {
  responseText: string;
  workspaceRoot: string;
  projectFolder?: string;
}): Promise<ClaimVerification | null> {
  const { responseText, workspaceRoot, projectFolder } = opts;
  if (!projectFolder) return null;

  const claims = extractFilenameClaims(responseText);
  if (claims.length === 0) return { verified: [], missing: [], hadClaims: false };

  const actualBasenames = await listProjectFilesShallow(workspaceRoot, projectFolder);

  const verified: string[] = [];
  const missing: string[] = [];
  for (const claim of claims) {
    if (actualBasenames.has(claim)) verified.push(claim);
    else missing.push(claim);
  }

  return { verified, missing, hadClaims: true };
}

/**
 * Format a verification result as a short block to append to the delegation
 * tool result the orchestrator sees. Returns null when nothing actionable
 * needs to be reported.
 */
export function formatVerificationBlock(v: ClaimVerification | null): string | null {
  if (!v || !v.hadClaims) return null;
  if (v.missing.length === 0) {
    // All claims matched files on disk — encouraging signal but not noisy
    return `\n\n✅ Verified ${v.verified.length} claimed file(s) exist on disk.`;
  }
  const verifiedLine = v.verified.length > 0
    ? `\n✅ Verified: ${v.verified.slice(0, 10).join(', ')}${v.verified.length > 10 ? `, +${v.verified.length - 10} more` : ''}`
    : '';
  return `\n\n⚠️ Claim verification: the delegate's report mentions files that do NOT exist on disk.${verifiedLine}\n❌ Missing (claimed but NOT found): ${v.missing.join(', ')}\nDo NOT report these missing files as created. Either re-delegate with explicit instructions to actually create them, or tell the user the work was incomplete.`;
}
