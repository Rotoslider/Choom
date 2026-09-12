/**
 * Room digest (Phase 4 of the context plan, 2026-09-12).
 *
 * A group turn sees only the newest TRANSCRIPT_WINDOW (24) room messages and
 * cross-turn compaction is skipped for rooms, so a long room silently lost
 * its beginning for every speaker. This keeps a rolling summary of everything
 * OLDER than the window, the way a 1:1 chat keeps Chat.compactionSummary —
 * stored as a file per room (no schema change), refreshed when older messages
 * appear that the stored digest has not covered, and injected into each
 * speaker's prompt as "EARLIER IN THIS ROOM".
 *
 * Cost: one summarizer call per round once a room outgrows the window; each
 * speaker in the same round reads the same file. Concurrent refreshes are
 * harmless (last write wins, both summaries cover the same messages).
 */
import fs from 'fs';
import path from 'path';

export interface RoomDigestMessage {
  id: string;
  authorName: string;
  content: string;
  createdAt: Date | string;
}

export interface RoomDigestStore {
  throughId: string;      // id of the newest OLDER message the summary covers
  coveredCount: number;   // how many older messages the summary covers
  summary: string;
  updatedAt: string;
}

export interface RoomDigestSummarizer {
  chat: (messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>) => Promise<{ content: string }>;
}

let roomDigestDir = path.join(process.cwd(), 'data', 'rooms');
/** Tests point this at a temp dir. */
export function setRoomDigestDir(dir: string): void { roomDigestDir = dir; }
export function getRoomDigestDir(): string { return roomDigestDir; }
const MAX_NEW_MESSAGES_PER_REFRESH = 80;
const EXCERPT_CHARS = 400;
const SUMMARY_TARGET = 'about 200-350 words';

export function digestPath(roomId: string): string {
  return path.join(roomDigestDir, roomId.replace(/[^A-Za-z0-9_-]/g, '_'), 'digest.json');
}

export function readDigest(roomId: string): RoomDigestStore | null {
  try {
    const raw = fs.readFileSync(digestPath(roomId), 'utf-8');
    const parsed = JSON.parse(raw) as RoomDigestStore;
    return parsed && typeof parsed.summary === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export function writeDigest(roomId: string, store: RoomDigestStore): void {
  const p = digestPath(roomId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(store, null, 2), 'utf-8');
}

/** The prompt block, or '' when there is nothing older than the window. */
export function formatDigestBlock(summary: string, coveredCount: number): string {
  if (!summary.trim()) return '';
  return `\n\n## EARLIER IN THIS ROOM\nA summary of the ${coveredCount} room messages before the ones shown below. Treat it as what everyone in the room remembers.\n${summary.trim()}`;
}

export function buildSummaryPrompt(existing: string | null, newer: RoomDigestMessage[]): string {
  const lines = newer.map(m => {
    const text = (m.content || '').replace(/\s+/g, ' ').trim();
    return `[${m.authorName}]: ${text.length > EXCERPT_CHARS ? text.slice(0, EXCERPT_CHARS) + '…' : text}`;
  }).join('\n');
  return `You keep the running summary of a group chat room between a person and their AI companions (who treat each other as sisters).
Update the summary so it stays ${SUMMARY_TARGET}: keep decisions, plans, things made (files, images), feelings expressed, open questions, and who said what when it matters. Drop chit-chat. Write it as plain prose in past tense. Output only the summary.

EXISTING SUMMARY:
${existing?.trim() || '(none yet)'}

NEW MESSAGES SINCE THEN (oldest first):
${lines}`;
}

/**
 * Return the digest block for a room whose OLDER messages (everything before
 * the transcript window) are `older`, oldest first. Refreshes the stored
 * digest when it does not cover the newest older message.
 */
export async function ensureRoomDigest(
  roomId: string,
  older: RoomDigestMessage[],
  summarizer: RoomDigestSummarizer,
): Promise<{ block: string; refreshed: boolean; coveredCount: number }> {
  if (older.length === 0) return { block: '', refreshed: false, coveredCount: 0 };
  const newestOlder = older[older.length - 1];
  const stored = readDigest(roomId);
  if (stored && stored.throughId === newestOlder.id) {
    return { block: formatDigestBlock(stored.summary, stored.coveredCount), refreshed: false, coveredCount: stored.coveredCount };
  }

  // Messages the stored digest has not seen yet (everything after throughId),
  // bounded so a room that grew a lot while nobody spoke still summarizes.
  let sinceIdx = 0;
  if (stored) {
    const at = older.findIndex(m => m.id === stored.throughId);
    if (at >= 0) sinceIdx = at + 1;
  }
  const newer = older.slice(sinceIdx).slice(-MAX_NEW_MESSAGES_PER_REFRESH);
  if (newer.length === 0) {
    return { block: formatDigestBlock(stored?.summary || '', stored?.coveredCount || 0), refreshed: false, coveredCount: stored?.coveredCount || 0 };
  }

  let summary: string;
  try {
    const result = await summarizer.chat([
      { role: 'system', content: 'You are a precise conversation summarizer. Output only the summary.' },
      { role: 'user', content: buildSummaryPrompt(stored?.summary || null, newer) },
    ]);
    summary = (result.content || '').trim();
  } catch (err) {
    console.warn(`   ⚠️  Room digest summarization failed for ${roomId}:`, err instanceof Error ? err.message : err);
    // Mechanical fallback: keep what we had plus the newest lines, trimmed.
    const tail = newer.slice(-8).map(m => `${m.authorName}: ${(m.content || '').replace(/\s+/g, ' ').slice(0, 160)}`).join(' ');
    summary = `${stored?.summary || ''} ${tail}`.trim().slice(-2400);
  }
  if (!summary) {
    return { block: formatDigestBlock(stored?.summary || '', stored?.coveredCount || 0), refreshed: false, coveredCount: stored?.coveredCount || 0 };
  }
  const store: RoomDigestStore = {
    throughId: newestOlder.id,
    coveredCount: (stored?.coveredCount || 0) + newer.length,
    summary,
    updatedAt: new Date().toISOString(),
  };
  writeDigest(roomId, store);
  return { block: formatDigestBlock(summary, store.coveredCount), refreshed: true, coveredCount: store.coveredCount };
}
