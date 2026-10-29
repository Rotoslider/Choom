/**
 * Loading only what's needed of an open chat. A long chat is large (Genesis's main chat: 1,694 messages,
 * 10 MB), and the page used to load it whole every 30 s with the chat list, and again after every
 * reply: over a metered link (ngrok's free 1 GB a month) that ran out in an afternoon (2026-10-28).
 * Now a chat opens with its latest MESSAGE_PAGE messages (GET /api/chats/[id]/messages?limit=), earlier
 * ones come a page at a time when asked for (&beforeId=), and ?since=<time> sends what's new: the
 * page keeps the older ones it has and replaces the rest.
 */
import type { Message } from '@/lib/types';

/** How many messages a chat opens with, and how many more each "Show earlier messages" brings. */
export const MESSAGE_PAGE = 150;

/** The earlier messages the server has for a page it sent (its X-Earlier-Messages). */
export const earlierOf = (res: Response): number => Number(res.headers.get('X-Earlier-Messages')) || 0;

/** Earlier messages put in front of the ones on screen (any already there aren't doubled). */
export function prependOlder(current: Message[], older: Message[]): Message[] {
  const have = new Set(current.map((m) => m.id));
  return [...older.filter((m) => !have.has(m.id)), ...current];
}

/** A message shown before it's saved (a send's own words, until the reply is in). */
export const isTemporary = (m: Message): boolean => m.id.startsWith('temp-');

const time = (t: Date | string): number => new Date(t).getTime();

/** When the newest saved message on screen was made, or null if there's none. */
export function newestSaved(messages: Message[]): string | null {
  let newest: number | null = null;
  for (const m of messages) {
    if (!isTemporary(m) && (newest === null || time(m.createdAt) > newest)) newest = time(m.createdAt);
  }
  return newest === null ? null : new Date(newest).toISOString();
}

/**
 * The chat on screen with the messages fetched since `since`: the saved ones before it are kept, and
 * from it on the server's copy is the chat (it may have changed or dropped the last of them); a send's
 * temporary words go, since the server has them saved now.
 */
export function mergeSince(current: Message[], fresh: Message[], since: string): Message[] {
  const from = time(since);
  return [...current.filter((m) => !isTemporary(m) && time(m.createdAt) < from), ...fresh];
}

/** Whether the chat list says the open chat changed after its newest saved message. */
export function changedSince(chatUpdatedAt: Date | string | undefined, since: string | null): boolean {
  return !!since && !!chatUpdatedAt && time(chatUpdatedAt) > time(since);
}
