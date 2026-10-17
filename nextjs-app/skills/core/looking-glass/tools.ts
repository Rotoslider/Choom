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
      'Change your clothes on the Looking Glass, from your closet there: "my red dress", "a sweater", "my usual clothes". The closest match is used. Day clothes stay on until 10 pm, when your night clothes go on; anything you put on after that you keep until you go to sleep. Change again whenever you like. Clothes you don\'t have yet go on Donny\'s wish list for the glass. To ask for new clothes without changing now, use glass_wish.',
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
    name: 'glass_wish',
    description:
      'Ask Donny for something new on the Looking Glass: clothes you\'d like to own there, or a move you\'d like to do. It goes on his wish list in Glass Studio, where he makes new outfits and moves over time. Nothing changes on the glass now. Describe it the way you picture it: colour, fabric, cut.',
    parameters: {
      type: 'object',
      properties: {
        wish: {
          type: 'string',
          description: 'What you\'d like, e.g. "a midnight-blue silk slip dress with lace trim", "sit by a campfire"',
        },
        kind: {
          type: 'string',
          enum: ['clothes', 'move'],
          description: 'clothes (the default) or a move',
        },
      },
      required: ['wish'],
    },
  },
  {
    name: 'glass_closet',
    description:
      'Lists what you can do and wear on the Looking Glass: your moves and the clothes in your closet there. It only lists and changes nothing; to change clothes, use glass_wear. It doesn\'t say what you have on at the moment.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];
