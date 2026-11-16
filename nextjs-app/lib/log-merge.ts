import type { LogEntry, LogLevel, LogCategory } from './types';

/** An Activity Log row as GET /api/logs returns it. */
export interface SavedLogRow {
  id: string;
  level: string;
  category: string;
  title: string;
  message: string;
  details?: string | null;
  duration?: number | null;
  createdAt: string;
}

/** A turn this page streamed itself: from when it sent his words until its stream ended (ms, this
 *  browser's clock; `to` is null while it runs). */
export interface OwnTurn {
  from: number;
  to: number | null;
}

// The Mac's clock against this browser's, and the server's last row landing after the stream ends.
const OWN_TURN_SLACK_MS = 3000;

/** A saved row as the panel shows it, its details parsed back into an object. */
export function fromSavedRow(log: SavedLogRow): LogEntry {
  let details: Record<string, unknown> | undefined;
  if (log.details) {
    try {
      const parsed = JSON.parse(log.details);
      // An object with keys keeps its shape; a bare string, number or array is wrapped
      details = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { raw: parsed };
    } catch {
      // Not JSON: wrap the raw string so the expand arrow still shows
      details = { raw: log.details };
    }
  }
  return {
    id: log.id,
    level: log.level as LogLevel,
    category: log.category as LogCategory,
    title: log.title,
    message: log.message,
    details,
    duration: log.duration || undefined,
    timestamp: new Date(log.createdAt),
  };
}

/**
 * Rows saved since the panel last looked, merged into what it shows (newest first, at most max), or
 * null when there's nothing new to show. Turns this page didn't stream (begun at the tower, on Signal,
 * by a heartbeat) are known to it only from these rows: the server saves each tool call and result as
 * it happens, but the page hears only its own turns (Nov 16 2026: Genesis worked half an hour on
 * Donny's contour map after he asked at the tower, and the open panel still ended at the night before).
 * - A row already shown (same id), or in `looked` (seen before, at the edge of the last look), is skipped.
 * - A row that is one of this page's own entries, saved a few seconds after it showed it: the shown
 *   entry with the same category, title and message that isn't matched yet takes it.
 * - A row the server saved during a turn this page streamed itself is skipped: the page showed that turn
 *   its own way already ("Calling run_command", where the server saves "Tool Call: run_command").
 */
export function mergeSavedRows(
  shown: LogEntry[],
  rows: SavedLogRow[],
  ownTurns: OwnTurn[],
  max: number,
  looked: ReadonlySet<string> = new Set(),
  now = Date.now(),
): LogEntry[] | null {
  const ids = new Set(shown.map((e) => e.id));
  const waiting = shown.filter((e) => e.unsaved);
  const matched = new Set<string>();
  const added: LogEntry[] = [];
  for (const row of [...rows].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))) {
    if (ids.has(row.id) || looked.has(row.id)) continue;
    const mine = waiting.findIndex((e) => e.category === row.category && e.title === row.title && e.message === row.message);
    if (mine >= 0) {
      matched.add(waiting[mine].id);
      waiting.splice(mine, 1);
      continue;
    }
    const at = Date.parse(row.createdAt);
    if (ownTurns.some((t) => at >= t.from - OWN_TURN_SLACK_MS && at <= (t.to ?? now) + OWN_TURN_SLACK_MS)) continue;
    added.push(fromSavedRow(row));
    ids.add(row.id);
  }
  if (added.length === 0 && matched.size === 0) return null;
  const kept = matched.size ? shown.map((e) => (matched.has(e.id) ? { ...e, unsaved: false } : e)) : shown;
  if (added.length === 0) return kept;
  return [...added, ...kept].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime()).slice(0, max);
}
