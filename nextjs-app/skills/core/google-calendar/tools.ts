import type { ToolDefinition } from '@/lib/types';

export const tools: ToolDefinition[] = [
  {
    name: 'get_calendar_events',
    description:
      'Get calendar events — upcoming and/or past. Use when the user asks about their calendar, schedule, or "what\'s on my calendar". Use days_back for past events like "what did I have last week".',
    parameters: {
      type: 'object',
      properties: {
        days_ahead: {
          type: 'number',
          description: 'Number of days to look ahead (default 7)',
        },
        days_back: {
          type: 'number',
          description: 'Number of days to look backward. Use when asking about past events (e.g. "last week" = 7, "last month" = 30)',
        },
        query: {
          type: 'string',
          description: 'Optional search filter to match event titles/descriptions',
        },
      },
    },
  },
  {
    name: 'create_calendar_event',
    description:
      'Create a new Google Calendar event. Use when the user says "add to my calendar", "schedule a meeting", "set an appointment", or asks to create any calendar event.',
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'Event title (e.g. "Dentist appointment", "Team meeting")',
        },
        start_time: {
          type: 'string',
          description: 'Start time in ISO 8601 format (e.g. "2026-02-10T14:00:00"). For all-day events, just the date "2026-02-10".',
        },
        end_time: {
          type: 'string',
          description: 'End time in ISO 8601 format. For all-day events, the day after (e.g. "2026-02-11"). If not provided, defaults to 1 hour after start.',
        },
        description: {
          type: 'string',
          description: 'Optional event description or notes',
        },
        location: {
          type: 'string',
          description: 'Optional event location',
        },
        all_day: {
          type: 'boolean',
          description: 'Set to true for all-day events (default false)',
        },
      },
      required: ['summary', 'start_time'],
    },
  },
  {
    name: 'update_calendar_event',
    description:
      'Update an existing Google Calendar event. Use when the user says "reschedule", "move my appointment", "change the meeting time", or wants to modify an event. Requires the event ID (get it from get_calendar_events first).',
    parameters: {
      type: 'object',
      properties: {
        event_id: {
          type: 'string',
          description: 'The Google Calendar event ID (from get_calendar_events results)',
        },
        summary: {
          type: 'string',
          description: 'New event title (optional)',
        },
        start_time: {
          type: 'string',
          description: 'New start time in ISO 8601 format (optional)',
        },
        end_time: {
          type: 'string',
          description: 'New end time in ISO 8601 format (optional)',
        },
        description: {
          type: 'string',
          description: 'New event description (optional)',
        },
        location: {
          type: 'string',
          description: 'New event location (optional)',
        },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'delete_calendar_event',
    description:
      'Delete a Google Calendar event. Use when the user says "cancel my appointment", "remove the meeting", or "delete from calendar". Requires the event ID (get it from get_calendar_events first).',
    parameters: {
      type: 'object',
      properties: {
        event_id: {
          type: 'string',
          description: 'The Google Calendar event ID (from get_calendar_events results)',
        },
      },
      required: ['event_id'],
    },
  },
];
