import type { ToolDefinition } from '@/lib/types';

export const tools: ToolDefinition[] = [
  {
    name: 'schedule_self_followup',
    description:
      "Queue a prompt YOU send to YOURSELF for later, in your PRIVATE 1:1 space. Fires as a one-shot heartbeat at the scheduled time, giving you a fresh turn to act on your own. Use when you want to revisit an unfinished thread, check back on something, or proactively follow up. PREFER `at` — just name the wall-clock time you want it to fire (Donny's local time, shown at the top of your context); no minutes math, no UTC. This is NOT a user-facing reminder — the message never reaches Donny unless you explicitly call send_notification. For coming back to a GROUP ROOM later, use schedule_room_followup instead. For user-facing reminders use create_reminder.",
    parameters: {
      type: 'object',
      properties: {
        at: {
          type: 'string',
          description: "EASIEST WAY: the wall-clock time to fire, in Donny's local (Mountain) time — exactly the time you want, no math. Accepts e.g. \"2026-06-26 2:05pm\", \"June 26 at 14:05\", \"tomorrow 9am\", or just \"2:05pm\" (next time it's that o'clock today/tomorrow). Provide EITHER this or delay_minutes.",
        },
        delay_minutes: {
          type: 'number',
          description: 'Alternative to `at`: minutes from now to fire. Clamped to [15, 43200] (15 min to 30 days). Use `at` instead when you know the target clock time.',
        },
        prompt: {
          type: 'string',
          description: 'What to tell future-you when this fires. Be specific: what to check, why, any context the future tick will need.',
        },
        reason: {
          type: 'string',
          description: 'One short line describing why this followup was queued. Shown in the Doctor report. Optional.',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'schedule_room_followup',
    description:
      "Schedule yourself to pop back into a GROUP ROOM later. When it fires you RE-ENTER that room — you'll see the latest conversation and your `prompt` becomes your opening line, so your sisters there can react. Use this (NOT schedule_self_followup) whenever you want to return to a room: continue a thread, check back in, or rejoin after stepping away. PREFER `at` — name the wall-clock time you want to return (Donny's local time); no minutes math. Works from inside a room (defaults to the room you're in) AND from a private 1:1 (name the room to plan a future group appearance).",
    parameters: {
      type: 'object',
      properties: {
        at: {
          type: 'string',
          description: "EASIEST WAY: the wall-clock time to re-enter, in Donny's local (Mountain) time. Accepts e.g. \"2026-06-26 2:05pm\", \"June 26 at 14:05\", \"tomorrow 9am\", or just \"2:05pm\". Provide EITHER this or delay_minutes.",
        },
        delay_minutes: {
          type: 'number',
          description: 'Alternative to `at`: minutes from now to re-enter. Clamped to [15, 43200] (15 min to 30 days).',
        },
        prompt: {
          type: 'string',
          description: 'Your opening line when you re-enter the room — what you want to say or pick up on.',
        },
        room: {
          type: 'string',
          description: "Optional room name. Omit to use the room you're currently in. Required only if you're in more than one room and not currently inside one.",
        },
        reason: {
          type: 'string',
          description: 'One short line on why (for the Doctor report). Optional.',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'list_self_followups',
    description: 'List your currently pending self-followups (not yet fired). Shows id, trigger time, and the prompt preview.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'cancel_self_followup',
    description: 'Cancel a pending self-followup by id. Use when you no longer need the followup or want to free a slot. ALWAYS call list_self_followups first to get the real ids (they look like "sf_1a2b3c4d") — do NOT guess ids like "1"/"2". To clear ALL your pending followups at once, pass id="all".',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The followup id from list_self_followups (e.g. "sf_1a2b3c4d"), or "all" to cancel every pending followup.',
        },
      },
      required: ['id'],
    },
  },
];
