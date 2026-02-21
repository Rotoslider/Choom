import type { ToolDefinition } from '@/lib/types';

export const tools: ToolDefinition[] = [
  {
    name: 'create_reminder',
    description:
      'Create a timed reminder that will be delivered via Signal message. Use when the user says "remind me", "set a reminder", or asks to be notified at a specific time. Supports relative minutes or absolute time.',
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
