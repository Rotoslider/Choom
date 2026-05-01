import type { ToolDefinition } from '@/lib/types';

export const tools: ToolDefinition[] = [
  {
    name: 'music_search',
    description: 'Search for music in the library or streaming providers. Returns matching artists, albums, tracks, playlists, and radio stations.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query — artist name, song title, album name, genre, etc.',
        },
        media_types: {
          type: 'string',
          description: 'Comma-separated types to search: artist,album,track,playlist,radio. Default: all types.',
        },
        limit: {
          type: 'number',
          description: 'Max results per type (default 5).',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'music_play',
    description: 'Play music on a speaker. Accepts a URI from search results, or a search query to auto-resolve. Can play artists, albums, tracks, playlists, or radio stations.',
    parameters: {
      type: 'object',
      properties: {
        media: {
          type: 'string',
          description: 'Music to play — either a URI from music_search results (e.g. "library://track/123") or a search query (e.g. "Tarja Turunen", "chill jazz playlist"). URIs are preferred for precision.',
        },
        player: {
          type: 'string',
          description: 'Player name or ID to play on (e.g. "Home Assistant Voice", "living room"). If omitted, uses the first available player.',
        },
        enqueue: {
          type: 'string',
          description: 'How to add to queue: "play" (replace queue and play now), "next" (play after current), "add" (append to end), "replace" (replace queue but don\'t start), "replace_next" (replace upcoming but keep current). Default: "play".',
          enum: ['play', 'next', 'add', 'replace', 'replace_next'],
        },
      },
      required: ['media'],
    },
  },
  {
    name: 'music_control',
    description: 'Control music playback — play, pause, stop, next, previous, volume, shuffle, repeat.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Playback action to perform.',
          enum: ['play', 'pause', 'stop', 'next', 'previous', 'volume_set', 'volume_up', 'volume_down', 'shuffle', 'repeat'],
        },
        player: {
          type: 'string',
          description: 'Player name or ID. If omitted, uses the first available player.',
        },
        value: {
          type: 'number',
          description: 'Value for volume_set (0-100).',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'music_now_playing',
    description: 'Get what is currently playing on a speaker, including track info, artist, album, playback state, volume, and queue contents.',
    parameters: {
      type: 'object',
      properties: {
        player: {
          type: 'string',
          description: 'Player name or ID. If omitted, returns info for all players.',
        },
      },
    },
  },
  {
    name: 'music_players',
    description: 'List all available music players/speakers with their current state, volume, and capabilities.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
];
