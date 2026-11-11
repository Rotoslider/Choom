/**
 * Choom turns under way right now, of every kind: web, Signal, heartbeats and delegation (each a
 * runChatTurn in lib/chat-stream.ts) and room runs (app/api/group-chat). GET /api/turns lists them.
 *
 * The weekly restart (scripts/weekly-restart.py, Sunday 1:30 am) waits until none is open, so
 * restarting the dev server never cuts a reply in half (2026-11-11, Donny: restart once a week
 * "between their followups and cron jobs so it does not scramble anything").
 *
 * Kept on globalThis like lib/chat-runs.ts, so a dev-server hot reload doesn't lose the turns
 * already running.
 */
export type TurnKind = 'chat' | 'heartbeat' | 'delegation' | 'group' | 'room';

type OpenTurn = { who: string; kind: TurnKind; since: number };

const store = globalThis as unknown as {
  __choomTurnsOpen?: Map<number, OpenTurn>;
  __choomTurnsNext?: number;
};
const open = (store.__choomTurnsOpen ??= new Map<number, OpenTurn>());

/** Marks a turn as under way. Call the returned function when it ends, however it ends. */
export function openTurn(who: string, kind: TurnKind, now = Date.now()): () => void {
  const id = (store.__choomTurnsNext = (store.__choomTurnsNext ?? 0) + 1);
  open.set(id, { who, kind, since: now });
  return () => {
    open.delete(id);
  };
}

/** The turns under way, oldest first, with how long each has run. */
export function turnsOpen(now = Date.now()): { who: string; kind: TurnKind; seconds: number }[] {
  return [...open.values()]
    .sort((a, b) => a.since - b.since)
    .map((t) => ({ who: t.who, kind: t.kind, seconds: Math.round((now - t.since) / 1000) }));
}
