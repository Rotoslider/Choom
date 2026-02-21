import type { ToolDefinition } from '@/lib/types';

export const tools: ToolDefinition[] = [
  {
    name: 'search_youtube',
    description:
      'Search YouTube for videos, channels, or playlists. Use when the user asks to find YouTube content.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of results (default 10, max 50)',
        },
        type: {
          type: 'string',
          description: 'Type of content to search for',
          enum: ['video', 'channel', 'playlist'],
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_video_details',
    description:
      'Get detailed information about a YouTube video including title, description, duration, view count, and channel.',
    parameters: {
      type: 'object',
      properties: {
        video_id: {
          type: 'string',
          description: 'YouTube video ID (e.g. "dQw4w9WgXcQ" from a YouTube URL)',
        },
      },
      required: ['video_id'],
    },
  },
  {
    name: 'get_channel_info',
    description:
      'Get information about a YouTube channel including name, description, subscriber count, and video count.',
    parameters: {
      type: 'object',
      properties: {
        channel_id: {
          type: 'string',
          description: 'YouTube channel ID (starts with UC, e.g. "UCxxxxxx")',
        },
      },
      required: ['channel_id'],
    },
  },
  {
    name: 'get_playlist_items',
    description:
      'List videos in a YouTube playlist.',
    parameters: {
      type: 'object',
      properties: {
        playlist_id: {
          type: 'string',
          description: 'YouTube playlist ID (starts with PL, e.g. "PLxxxxxx")',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of items to return (default 20, max 50)',
        },
      },
      required: ['playlist_id'],
    },
  },
];
