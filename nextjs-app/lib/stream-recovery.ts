import type { Message } from './types';

/**
 * Recovering a chat turn whose response stream died mid-flight.
 *
 * The server does not care that the browser went away — it finishes the agent
 * loop and persists the reply regardless. A real case on 2026-09-11: the stream
 * broke at 13:36:28 and the 2420-character answer landed in the DB at 13:37:02,
 * 34s later, where nothing in the UI ever went looking for it. The user was left
 * with a turn that had silently vanished.
 *
 * This RESYNCS rather than retries, and the distinction matters. Re-POSTing
 * /api/chat would re-run the whole turn — tool calls, image generation, memory
 * writes — racing the original that is usually still running and about to
 * succeed, leaving duplicate images behind. Polling for an answer the server
 * already has cannot duplicate anything.
 */

/**
 * Backoff out to ~3 minutes. Long agent turns keep iterating well after the
 * stream drops (the real case was still on iteration 5 of a possible 100), and
 * the answer is worth more than giving up quickly.
 */
export const RECOVERY_DELAYS = [2000, 3000, 5000, 10000, 15000, 30000, 45000, 60000];

/**
 * Did the turn we were waiting on actually land?
 *
 * Only an assistant message newer than the moment we sent counts. Without the
 * timestamp check, any older reply already on screen would read as a successful
 * recovery and we would stop polling for one that never arrived.
 */
export function hasNewAssistantReply(messages: Message[], sentAt: number): boolean {
  return messages.some((m) => {
    if (m.role !== 'assistant') return false;
    const at = new Date(m.createdAt).getTime();
    // An unparseable timestamp must not be treated as fresh.
    return Number.isFinite(at) && at > sentAt;
  });
}

export interface RecoverReplyOptions {
  sentAt: number;
  /** Re-read the chat from the server. Resolves null if the read failed. */
  loadMessages: () => Promise<Message[] | null>;
  sleep: (ms: number) => Promise<void>;
  /** True once a newer send or a chat switch has superseded this recovery. */
  isStale: () => boolean;
  delays?: number[];
}

/**
 * Poll until the reply shows up. Resolves the recovered messages, or null if
 * the turn never landed or the recovery was superseded.
 */
export async function recoverReply({
  sentAt,
  loadMessages,
  sleep,
  isStale,
  delays = RECOVERY_DELAYS,
}: RecoverReplyOptions): Promise<Message[] | null> {
  for (const delay of delays) {
    await sleep(delay);
    if (isStale()) return null;

    // A failed read this round is not fatal — the next attempt can still win.
    const messages = await loadMessages().catch(() => null);
    if (!messages) continue;

    if (hasNewAssistantReply(messages, sentAt)) {
      // Re-check: the await above is another chance for a newer send to start.
      return isStale() ? null : messages;
    }
  }
  return null;
}
