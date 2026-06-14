import type { ToolDefinition } from '@/lib/types';

export const tools: ToolDefinition[] = [
  {
    name: 'create_reminder',
    description:
      'USER-FACING reminder: sends DONNY a Signal message at a future time. DECISION RULE — who is the message for? If it is for Donny ("remind me…", "set a reminder…", "let me know when…") use this. If it is a note to YOURSELF to revisit/check back/follow up later, use schedule_self_followup instead (that gives future-you a fresh turn and does NOT ping Donny). When in doubt, it is probably a self-followup. The reminder text should be written TO Donny (second person), never about yourself.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The reminder message text',
        },
        minutes_from_now: {
          type: 'number',
          description: 'Minutes from now to trigger the reminder (e.g. 30 for "in 30 minutes")',
        },
        time: {
          type: 'string',
          description: 'Specific time for the reminder — "4:00 PM", "3:30 AM", "15:00", or bare "4pm". A date may be included ("2026-06-14 9:00 AM", "6/14 5pm"); a timezone suffix like "MDT" is accepted and ignored (times are Mountain). Bare times with no date roll to tomorrow if already past today.',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'get_reminders',
    description:
      'Get pending reminders. Use when the user asks "show my reminders", "what reminders do I have", or "any reminders today". Optionally filter by date.',
    parameters: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'Optional ISO date to filter reminders (e.g. "2026-02-09")',
        },
      },
    },
  },
];
