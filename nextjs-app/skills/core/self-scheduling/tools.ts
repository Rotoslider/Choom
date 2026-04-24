import type { ToolDefinition } from '@/lib/types';

export const tools: ToolDefinition[] = [
  {
    name: 'schedule_self_followup',
    description:
      "Queue a prompt YOU send to YOURSELF for later. Fires as a one-shot heartbeat at the scheduled time, giving you a fresh turn to act. Use when you want to revisit an unfinished thread, check back on something, or proactively follow up without the user prompting you. This is NOT a user-facing reminder — the message never reaches Donny unless you explicitly call send_notification when the followup fires. For user-facing reminders use create_reminder instead.",
    parameters: {
      type: 'object',
      properties: {
        delay_minutes: {
          type: 'number',
          description: 'Minutes from now to fire the followup. Clamped to [5, 43200] (5 min to 30 days).',
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
      required: ['delay_minutes', 'prompt'],
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
    description: 'Cancel a pending self-followup by id. Use when you no longer need the followup or want to free a slot for a new one.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The followup id from list_self_followups.',
        },
      },
      required: ['id'],
    },
  },
];
