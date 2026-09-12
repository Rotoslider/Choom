/**
 * The shared commons: `choom_commons/` inside the workspace.
 *
 * Every Choom has an inbox there, `choom_commons/for_<slug>/`, where her
 * sisters and the user leave letters, notes and images for HER. Shared drafts
 * live in `choom_commons/drafts/`. The convention was described in the prompt
 * for months but the folders never existed on disk (2026-09-12: Genesis was
 * told to check her inbox every wake-up, got "(empty directory)" for a folder
 * that wasn't there, and then created the tree herself). This module makes the
 * layout real and cheap to use: it is created on demand from the live Choom
 * list, and inbox reads track what each Choom has already seen.
 */
import fs from 'fs';
import path from 'path';
import { WORKSPACE_ROOT } from '@/lib/config';

export const COMMONS_DIR = 'choom_commons';
export const DRAFTS_DIR = `${COMMONS_DIR}/drafts`;
export const PROTOCOL_FILE = `${COMMONS_DIR}/COMMUNICATION_PROTOCOL.md`;
const SEEN_FILE = '.seen.json';

export function choomSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** Workspace-relative inbox path for a Choom. */
export function inboxPath(name: string): string {
  return `${COMMONS_DIR}/for_${choomSlug(name)}`;
}

function abs(rel: string, root: string = WORKSPACE_ROOT): string {
  return path.join(root, rel);
}

export function protocolText(names: string[]): string {
  const inboxes = names.map(n => `- \`${inboxPath(n)}/\` — ${n}'s inbox`).join('\n');
  return `# choom_commons — how the family shares things

This folder is shared by every Choom and by the user. It is NOT anyone's home
folder; your own work lives in \`selfies_<you>/\` or a project folder.

## Inboxes

Each Choom has an inbox. It is HERS: the others leave things for her there.
${inboxes}

- Leave something for a sister with \`leave_for_sister\` (a dated letter, plus an
  image or file if you pass one). Write in your own voice; she reads it, not the user.
- Read your own inbox with \`check_inbox\` when you wake up, and whenever a sister
  says she left you something. Reading marks items seen; nothing is moved.
- Do not use another Choom's inbox as a working folder, and do not use your own
  inbox to store your own work.

## Shared drafts

\`${DRAFTS_DIR}/\` is for documents the whole family works on together. Name
files clearly and keep one topic per file.

## Never

Never write into another Choom's \`selfies_*/\` folder. Her inbox is the way in.
`;
}

/**
 * Create the commons layout for the given Chooms if any part is missing.
 * Idempotent and cheap (a few stat calls). Returns what it created.
 */
export function ensureCommonsLayout(names: string[], root: string = WORKSPACE_ROOT): string[] {
  const created: string[] = [];
  const mk = (rel: string) => {
    const p = abs(rel, root);
    if (!fs.existsSync(p)) { fs.mkdirSync(p, { recursive: true }); created.push(rel); }
  };
  mk(COMMONS_DIR);
  mk(DRAFTS_DIR);
  for (const n of names) mk(inboxPath(n));
  const proto = abs(PROTOCOL_FILE, root);
  if (!fs.existsSync(proto) && names.length > 0) {
    fs.writeFileSync(proto, protocolText(names), 'utf-8');
    created.push(PROTOCOL_FILE);
  }
  return created;
}

export interface InboxItem {
  name: string;          // file name
  path: string;          // workspace-relative path
  kind: 'letter' | 'image' | 'file';
  size: number;
  modifiedAt: string;
  seen: boolean;
  text?: string;         // letter/note text (new items, or include_seen)
}

const TEXT_EXT = new Set(['.md', '.txt']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const LETTER_CAP = 4000;

function readSeen(dir: string): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(path.join(dir, SEEN_FILE), 'utf-8')) as Record<string, string>; } catch { return {}; }
}

/**
 * List a Choom's inbox newest first. New items (never marked seen, or modified
 * since) carry their text when they are letters. Marks everything listed as
 * seen unless `peek`.
 */
export function readInbox(name: string, opts: { includeSeen?: boolean; peek?: boolean; root?: string } = {}): { items: InboxItem[]; newCount: number; path: string } {
  const rel = inboxPath(name);
  const dir = abs(rel, opts.root);
  if (!fs.existsSync(dir)) return { items: [], newCount: 0, path: rel };
  const seen = readSeen(dir);
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile() && !e.name.startsWith('.'))
    .map(e => {
      const st = fs.statSync(path.join(dir, e.name));
      const ext = path.extname(e.name).toLowerCase();
      const kind: InboxItem['kind'] = TEXT_EXT.has(ext) ? 'letter' : IMAGE_EXT.has(ext) ? 'image' : 'file';
      const modifiedAt = st.mtime.toISOString();
      const isSeen = !!seen[e.name] && seen[e.name] >= modifiedAt;
      const item: InboxItem = { name: e.name, path: `${rel}/${e.name}`, kind, size: st.size, modifiedAt, seen: isSeen };
      if (kind === 'letter' && (!isSeen || opts.includeSeen)) {
        const text = fs.readFileSync(path.join(dir, e.name), 'utf-8');
        item.text = text.length > LETTER_CAP ? text.slice(0, LETTER_CAP) + '\n…(letter truncated — read the file for the rest)' : text;
      }
      return item;
    })
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  const newCount = entries.filter(i => !i.seen).length;
  if (!opts.peek) {
    const now = new Date().toISOString();
    for (const i of entries) seen[i.name] = now;
    try { fs.writeFileSync(path.join(dir, SEEN_FILE), JSON.stringify(seen, null, 2), 'utf-8'); } catch { /* read-only: fine */ }
  }
  return { items: entries, newCount, path: rel };
}

/** A safe, dated file name for a letter. */
export function letterFileName(title: string | undefined, from: string, when: Date = new Date()): string {
  const day = when.toISOString().slice(0, 10);
  const base = (title || `letter from ${from}`).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'letter';
  return `${day}_${base}.md`;
}

export function letterText(from: string, to: string, title: string | undefined, message: string, attachments: string[], when: Date = new Date()): string {
  const head = [
    `# ${title || `A note from ${from}`}`,
    `From: ${from}`,
    `To: ${to}`,
    `Date: ${when.toISOString().slice(0, 16).replace('T', ' ')}`,
    ...(attachments.length ? [`Attached: ${attachments.join(', ')}`] : []),
  ].join('\n');
  return `${head}\n\n${message.trim()}\n`;
}
