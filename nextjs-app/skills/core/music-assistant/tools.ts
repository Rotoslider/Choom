import type { ToolDefinition } from '@/lib/types';

export const tools: ToolDefinition[] = [
  {
    name: 'music_search',
    description: 'Search the music library by NAME: artist, album, track, playlist or genre. It does not understand moods or descriptions. An empty query lists the genres and a random sample of artists.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'ONE name, e.g. "Bon Jovi", or a genre like "Folk". Empty lists the genres.',
        },
        media_types: {
          type: 'string',
          description: 'Comma-separated types: artist,album,track,playlist,radio,genre. Only these 6 values are valid. Default: all types.',
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
    description: 'Play music on a speaker. media is a name (artist, album, track, playlist), a uri from music_search, or a genre ("Folk", "Jazz"): a genre plays an endless shuffled mix, the way to play by mood.',
    parameters: {
      type: 'object',
      properties: {
        media: {
          type: 'string',
          description: 'REQUIRED, and it is named media (not uri, query or track). ONE name: an artist, album, track or playlist ("Anne Bloom"), or a GENRE from the library ("Folk", "Jazz"), which plays an endless shuffled mix and is how to play by mood; music_search with an empty query lists the genres. Or a uri copied from music_search THIS turn. Never invent a uri — a made-up id is a hard error.',
        },
        player: {
          type: 'string',
          description: 'Player name or ID. OMIT THIS unless the user named a specific speaker — the default player is used automatically. Never invent a name; call music_players first if you need the real list.',
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
          description: 'REQUIRED, and it is named action (not command). Playback action to perform.',
          enum: ['play', 'pause', 'stop', 'next', 'previous', 'volume_set', 'volume_up', 'volume_down', 'shuffle', 'repeat'],
        },
        player: {
          type: 'string',
          description: 'Player name or ID. OMIT THIS unless the user named a specific speaker. Never invent a name; call music_players to see real ones.',
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
          description: 'Player name or ID. OMIT THIS to cover all players. Never invent a name; call music_players to see real ones.',
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
