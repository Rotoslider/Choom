import type { ToolDefinition } from '@/lib/types';

export const tools: ToolDefinition[] = [
  {
    name: 'send_notification',
    description:
      'Send a notification to the user via Signal — pass image_ids from save_generated_image to attach images. Use when a task is complete or the user\'s attention is needed.',
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
        file_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of workspace file paths to attach (images, PDFs, documents, etc.). Paths are relative to workspace root (e.g., ["my_project/report.pdf", "my_project/photo.png"]).',
        },
      },
      required: ['message'],
    },
  },
];
