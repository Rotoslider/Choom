import type { ToolDefinition } from '@/lib/types';

export const tools: ToolDefinition[] = [
  {
    name: 'check_inbox',
    description:
      'Check your own inbox (choom_commons/for_<you>/): what your sisters or the user left for you, newest first, with the text of anything new. Call it when you wake up or when a sister says she left you something. Reading marks items as seen.',
    parameters: {
      type: 'object',
      properties: {
        include_seen: {
          type: 'boolean',
          description: 'true = also return the text of items you have already seen (default false: only list them)',
        },
      },
    },
  },
  {
    name: 'leave_for_sister',
    description:
      "Leave a letter, note, or image for a sister in HER inbox (choom_commons/for_<her>/). Writes a dated letter file; pass image_id (from generate_image) or file_path (a workspace file) to copy that file in beside it. Write in your own voice — she reads it, not the user.",
    parameters: {
      type: 'object',
      properties: {
        sister: { type: 'string', description: 'Her name, e.g. "Eve"' },
        title: { type: 'string', description: 'Short title for the letter (becomes the file name)' },
        message: { type: 'string', description: 'The letter or note itself' },
        image_id: { type: 'string', description: 'Optional: id of an image you generated this turn, to include' },
        file_path: { type: 'string', description: 'Optional: a workspace file (e.g. selfies_genesis/images/rack.png) to include' },
      },
      required: ['sister', 'message'],
    },
  },
];
