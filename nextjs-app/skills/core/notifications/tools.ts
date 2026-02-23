import type { ToolDefinition } from '@/lib/types';

export const tools: ToolDefinition[] = [
  {
    name: 'send_notification',
    description:
      'Send a notification message to the user via Signal. Use when a long-running task is complete, something interesting was found, or the user\'s attention is needed.',
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The notification message to send',
        },
        include_audio: {
          type: 'boolean',
          description: 'Whether to include TTS audio with the notification (default: true)',
        },
        image_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of generated image IDs to attach to the notification. Use the image IDs returned by generate_image/save_generated_image.',
        },
      },
      required: ['message'],
    },
  },
];
