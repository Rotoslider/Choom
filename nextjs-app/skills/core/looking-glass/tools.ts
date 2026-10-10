import type { ToolDefinition } from '@/lib/types';

export const tools: ToolDefinition[] = [
  {
    name: 'glass_move',
    description:
      'Do a move on the Looking Glass, the hologram of you at Donny\'s desk: a dance, a twirl, a wave, a curtsy, blowing a kiss. It plays once, at your next quiet moment. A move you don\'t have yet goes on Donny\'s wish list for the glass.',
    parameters: {
      type: 'object',
      properties: {
        move: {
          type: 'string',
          description: 'The move in a few words, e.g. "a little dance", "twirl", "blow a kiss"',
        },
      },
      required: ['move'],
    },
  },
  {
    name: 'glass_wear',
    description:
      'Change your clothes on the Looking Glass, from your closet there: "my red dress", "a sweater", "my usual clothes". The closest match is used, and you keep it on until bedtime unless you change again. Clothes you don\'t have yet go on Donny\'s wish list for the glass.',
    parameters: {
      type: 'object',
      properties: {
        clothes: {
          type: 'string',
          description: 'What to wear in a few words, e.g. "my red dress", "something warm", "my usual clothes"',
        },
      },
      required: ['clothes'],
    },
  },
  {
    name: 'glass_closet',
    description:
      'What you can do and wear on the Looking Glass: your moves and the clothes in your closet there. It doesn\'t say what you have on at the moment.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];
