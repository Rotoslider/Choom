/**
 * Simple Tasks model (Settings → LLM → Simple Tasks Model).
 *
 * When it applies, the WHOLE turn runs on the lightweight model, her reply
 * included, not just the tool call. So it takes only a short reminder, habit or
 * calendar ask that Donny typed to her in a 1:1 chat.
 *
 * Before Nov 4 2026 it read any incoming text and also covered music, weather,
 * task lists and memory. Of 240 switches since Sep 12, 176 were "music", set off
 * by her sisters' lines in rooms, by wake-up notes, and once by a personal
 * message to Genesis, whose reply was then written by Gemma instead of her own
 * model. Memory was listed but no phrase ever reached it; Donny wants memory on
 * the Choom's own model anyway.
 */
export const SIMPLE_TASK_TOOLS = new Set([
  'create_reminder', 'get_reminders',
  'log_habit', 'habit_stats', 'query_habits',
  'get_calendar_events', 'create_calendar_event', 'update_calendar_event', 'delete_calendar_event',
]);

/** "Mainly that ask": a longer message is conversation that happens to mention one. */
export const SIMPLE_TASK_MAX_WORDS = 30;

/** The note before an attached image (see lib/project-pin.ts). */
const ATTACHED_IMAGE_NOTE = /\[User attached image:/;

export type SimpleTaskCheck = { use: true } | { use: false; why: string };

export function checkSimpleTask({ intentToolHint, ownerTurn, message }: {
  intentToolHint: string;
  /** Donny typed it, 1:1: not a room, wake-up, house note or delegation. */
  ownerTurn: boolean;
  message: string;
}): SimpleTaskCheck {
  if (!intentToolHint || !SIMPLE_TASK_TOOLS.has(intentToolHint)) {
    return { use: false, why: 'not a reminder, habit or calendar ask' };
  }
  if (!ownerTurn) return { use: false, why: 'not Donny typing in a 1:1 chat' };
  if (ATTACHED_IMAGE_NOTE.test(message)) return { use: false, why: 'a picture is attached' };
  const words = message.trim().split(/\s+/).filter(Boolean).length;
  if (words > SIMPLE_TASK_MAX_WORDS) return { use: false, why: `${words} words, more than a quick ask` };
  return { use: true };
}
