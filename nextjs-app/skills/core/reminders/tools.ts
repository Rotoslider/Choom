import type { ToolDefinition } from '@/lib/types';

export const tools: ToolDefinition[] = [
  {
    name: 'create_reminder',
    description:
      'USER-FACING reminder. Creates a Signal message that will be delivered to Donny at a future time. Use ONLY when Donny says "remind me…", "set a reminder…", or asks to be notified. Do NOT use to schedule your own future turns — for that, use schedule_self_followup.',
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
          description: 'Specific time for the reminder — "4:00 PM", "3:30 AM", "15:00", or bare "4pm"',
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
