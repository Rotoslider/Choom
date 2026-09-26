import type { ToolDefinition } from '@/lib/types';

export const tools: ToolDefinition[] = [
  {
    name: 'get_weather',
    description:
      'Get CURRENT weather conditions. Use for "what\'s the weather now", "current temp", "is it raining". Omit location for user\'s home area, or pass a city name for a different location. For the AREA — "did it rain around here last night", "who got rain", "how windy is it in the valley" — pass stations="local" instead: the user\'s watched nearby stations with rain (last 24h / today / 7 days) and wind.',
    parameters: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: 'City name (e.g. "Denver, CO"), or a named place: "camp" / "Chiricahua Mountains" / "Rustler Park" resolve to the mountain camp at ~8,900 ft (a different climate from home — never substitute Portal or Rodeo for it). A Weather Underground station id (e.g. "KNMRODEO32") reads that station. Omit for user\'s home — that is the user\'s own weather station.',
        },
        stations: {
          type: 'string',
          description: '"local" = roundup of the user\'s watched stations around home. Or one or more Weather Underground station ids, comma-separated (e.g. a station near camp the user asked you to keep an eye on). Replaces location.',
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
          description: 'City name (e.g. "Denver, CO"), or a named place: "camp" / "Chiricahua Mountains" / "Rustler Park" resolve to the mountain camp at ~8,900 ft (a different climate from home — never substitute Portal or Rodeo for it). A Weather Underground station id (e.g. "KNMRODEO32") reads that station. Omit for user\'s home — that is the user\'s own weather station.',
        },
        days: {
          type: 'number',
          description: 'Number of forecast days (1-5, default 5)',
        },
      },
    },
  },
];
