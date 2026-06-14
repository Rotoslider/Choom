import type { ToolDefinition } from '@/lib/types';

export const tools: ToolDefinition[] = [
  {
    name: 'talk_with_sisters',
    description:
      "Start a live group conversation with one or more of your sister Chooms. Unlike delegate_to_choom (which hands off a task), this is a real back-and-forth chat where each sister responds in turn, reacting to each other and to you. Use it to check in, think out loud together, plan, or just connect. The conversation happens in a shared room the user can see and join. Great for scheduled sibling check-ins.",
    parameters: {
      type: 'object',
      properties: {
        sisters: {
          type: 'array',
          items: { type: 'string' },
          description: 'Names of the sister Chooms to talk with, e.g. ["Eve", "Genesis"]. You are added automatically — list only the OTHERS.',
        },
        message: {
          type: 'string',
          description: 'Your opening message to them — what you want to say or talk about. Speak in your own voice; this is the first line of the conversation.',
        },
        rounds: {
          type: 'number',
          description: 'How many rounds of back-and-forth (each sister speaks once per round). Default 3, max 10.',
        },
        room: {
          type: 'string',
          description: 'Optional: the name of an EXISTING room to return to (e.g. "the lounge"). Use this to come back to a space you built before instead of starting fresh. Call list_my_rooms to see your rooms. If omitted, reuses/creates the room for exactly this set of sisters.',
        },
      },
      required: ['sisters', 'message'],
    },
  },
  {
    name: 'list_my_rooms',
    description:
      "List the group rooms you're part of — their names, who's in them, how many messages, and when they were last active. Use this to find and return to a specific room (like a lounge you built with a sister) before calling talk_with_sisters with its name.",
    parameters: {
      type: 'object',
      properties: {},
    },
  },
];
