import type { ToolDefinition } from '@/lib/types';

export const tools: ToolDefinition[] = [
  {
    name: 'send_notification',
    description:
      'Send a notification to the user via Signal. Pass image_ids or file_paths to explicitly attach media. If neither is given, the handler auto-attaches images you created in the last 90 seconds (max 2) — so call send_notification close to the image creation to control what gets sent. To suppress auto-attach, set skip_auto_attach:true.',
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
          description: 'Array of workspace file paths to attach (images, PDFs, markdown, source code, etc.) — relative to workspace root, e.g. ["mars_project/spec.md","mars_project/photo.png"]. ALWAYS use this for workspace files instead of pasting local paths into the message text (those links do not open on a phone). Image files (.jpg/.jpeg/.png/.gif/.webp/.bmp) push inline; other files queue for pull-on-demand and the user reads them when they reply "show me the files". If you pass any image file here, auto-attach of recent generated images is skipped.',
        },
        skip_auto_attach: {
          type: 'boolean',
          description: 'Set to true to disable the auto-attach of recent images. Use when you want to send a text-only notification even though you recently created images.',
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'heartbeat_complete',
    description:
      'Signal that your heartbeat message is finished. Call this ONCE at the end of a heartbeat, after your text response is written. This terminates the agentic loop cleanly and records your action summary for the UCB1 reward signal. Only available during heartbeats — do not call in regular chat.',
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'One short sentence summarizing what this heartbeat did (topic, tone, anything notable). Used for anti-repetition on future heartbeats.',
        },
      },
      required: ['summary'],
    },
  },
];
