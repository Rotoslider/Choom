import type { ToolDefinition } from '@/lib/types';

export const tools: ToolDefinition[] = [
  {
    name: 'log_habit',
    description:
      'Log a daily activity or habit. Use when the user mentions doing something: "filled the truck with gas", "went to Walmart", "took a shower", "went camping at Lake Tahoe". Parse natural language into structured fields.',
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description:
            'Activity category: vehicle, hygiene, shopping, outdoor, maintenance, health, food, travel, social, finance',
        },
        activity: {
          type: 'string',
          description:
            'Short activity description, e.g. "filled gas", "shower", "went to Walmart", "camping"',
        },
        location: {
          type: 'string',
          description: 'Optional location where the activity happened, e.g. "Lake Tahoe", "Shell on 5th St"',
        },
        notes: {
          type: 'string',
          description: 'Optional freeform notes about the activity',
        },
        quantity: {
          type: 'number',
          description: 'Optional numeric quantity, e.g. 15.5 for gallons, 47.50 for dollars',
        },
        unit: {
          type: 'string',
          description: 'Optional unit for the quantity, e.g. "gallons", "$", "miles", "hours"',
        },
        timestamp: {
          type: 'string',
          description:
            'ONLY for past events ("yesterday I...", "last Tuesday..."). Omit for things happening now — server uses current time automatically. ISO 8601 format with date only (e.g. "2026-04-01") for past dates.',
        },
      },
      required: ['category', 'activity'],
    },
  },
  {
    name: 'query_habits',
    description:
      'Search and filter habit entries. Use when the user asks about past activities: "when did I last get gas?", "show my outdoor activities this month", "how many times did I shower this week?"',
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: 'Filter by category (e.g. "vehicle", "hygiene")',
        },
        activity: {
          type: 'string',
          description: 'Filter by activity keyword (partial match, e.g. "gas", "shower")',
        },
        location: {
          type: 'string',
          description: 'Filter by location keyword (partial match)',
        },
        date_from: {
          type: 'string',
          description: 'Start date filter (ISO 8601, e.g. "2026-03-01")',
        },
        date_to: {
          type: 'string',
          description: 'End date filter (ISO 8601, e.g. "2026-03-31")',
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return (default: 20)',
        },
        order: {
          type: 'string',
          description: 'Sort order: "newest" (default) or "oldest"',
          enum: ['newest', 'oldest'],
        },
      },
    },
  },
  {
    name: 'habit_stats',
    description:
      'Get habit statistics, trends, and streaks. Use when the user asks "how often do I...", "what did I do this week?", "monthly breakdown", or wants to see trends.',
    parameters: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          description: 'Time period for stats: "day", "week", "month", "year", "all"',
          enum: ['day', 'week', 'month', 'year', 'all'],
        },
        category: {
          type: 'string',
          description: 'Optional: limit stats to a specific category',
        },
        activity: {
          type: 'string',
          description: 'Optional: limit stats to a specific activity (partial match)',
        },
      },
    },
  },
  {
    name: 'manage_categories',
    description:
      'List, add, or update habit categories. Use when user wants to see categories, add a new one, or change colors/icons.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action to perform',
          enum: ['list', 'add', 'update'],
        },
        name: {
          type: 'string',
          description: 'Category name (required for add/update)',
        },
        icon: {
          type: 'string',
          description: 'Emoji icon for the category',
        },
        color: {
          type: 'string',
          description: 'Hex color for charts (e.g. "#3b82f6")',
        },
        description: {
          type: 'string',
          description: 'Category description',
        },
      },
    },
  },
  {
    name: 'delete_habit',
    description:
      'Delete a habit entry by ID. Use when user wants to remove an incorrect or duplicate entry.',
    parameters: {
      type: 'object',
      properties: {
        entry_id: {
          type: 'string',
          description: 'The ID of the habit entry to delete',
        },
      },
      required: ['entry_id'],
    },
  },
];
