import type { ToolDefinition } from '@/lib/types';

export const tools: ToolDefinition[] = [
  {
    name: 'get_weather',
    description:
      'Get CURRENT weather conditions. Use for "what\'s the weather now", "current temp", "is it raining". Omit location for user\'s home area, or pass a city name for a different location.',
    parameters: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: 'City name (e.g. "Denver, CO"). Omit for user\'s home location.',
        },
      },
    },
  },
  {
    name: 'get_weather_forecast',
    description:
      'Get 5-day weather FORECAST. Use when user asks about FUTURE weather: "tomorrow", "this week", "will it rain", "forecast", "weekend weather". For current conditions use get_weather instead.',
    parameters: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: 'City name (e.g. "Denver, CO"). Omit for user\'s home location.',
        },
        days: {
          type: 'number',
          description: 'Number of forecast days (1-5, default 5)',
        },
      },
    },
  },
];
