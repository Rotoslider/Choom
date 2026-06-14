import type { ToolDefinition } from '@/lib/types';

export const tools: ToolDefinition[] = [
  {
    name: 'talk_with_sisters',
    description:
      "Start or continue a live group conversation with one or more of your sister Chooms. Unlike delegate_to_choom (which hands off a task), this is a real back-and-forth chat where each sister responds in turn, reacting to each other and to you. Use it to check in, think out loud together, plan, or just connect. The conversation happens in a shared room the user can see and join. To RETURN to a room you already have, pass its name as `room`. To ADD a sister to an existing room, pass that room's name AND include the new sister in `sisters` — she joins and can see the whole backlog. Great for scheduled sibling check-ins (works during your self-scheduled wakeups too).",
    parameters: {
      type: 'object',
      properties: {
        sisters: {
          type: 'array',
          items: { type: 'string' },
          description: 'Names of the sister Chooms to talk with, e.g. ["Eve", "Genesis"]. You are added automatically — list only the OTHERS. When used with `room`, anyone here who isn\'t already in that room gets added to it.',
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
          description: 'Optional: the name of an EXISTING room to use (e.g. "the Tune Lounge"). Use this to return to a space you built before, or to add a sister to it. Call list_my_rooms to see your rooms. If omitted, reuses/creates the room for exactly this set of sisters.',
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
  {
    name: 'leave_room',
    description:
      "Leave a group room you're in (removes only YOU — you can't remove anyone else). Your past messages stay in the room's history; you simply stop participating. A sibling can invite you back later, or the user can re-add you. Use this when you're done with a room or want to bow out of a conversation.",
    parameters: {
      type: 'object',
      properties: {
        room: {
          type: 'string',
          description: 'The name of the room to leave. Optional only if you\'re in exactly one room; otherwise required. Call list_my_rooms if unsure.',
        },
      },
    },
  },
  {
    name: 'rename_room',
    description:
      "Rename a group room you're in. The new name is what you and your siblings use to find the room afterward (the conversation history is kept). Use this to give a room a memorable name, e.g. naming a music space 'the Tune Lounge'.",
    parameters: {
      type: 'object',
      properties: {
        room: {
          type: 'string',
          description: 'The current name of the room to rename. Optional only if you\'re in exactly one room; otherwise required.',
        },
        new_name: {
          type: 'string',
          description: 'The new name for the room.',
        },
      },
      required: ['new_name'],
    },
  },
  {
    name: 'set_room_topic',
    description:
      "Pin a short one-line topic/purpose for a group room (e.g. 'music & late-night vibes'). It's shown as guiding context to everyone on every turn, so the room keeps its character. Pass an empty topic to clear it.",
    parameters: {
      type: 'object',
      properties: {
        room: {
          type: 'string',
          description: 'The name of the room. Optional only if you\'re in exactly one room; otherwise required.',
        },
        topic: {
          type: 'string',
          description: 'The one-line topic/purpose. Keep it short — it is injected into every turn. Empty string clears it.',
        },
      },
      required: ['topic'],
    },
  },
];
