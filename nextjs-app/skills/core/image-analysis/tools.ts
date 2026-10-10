import type { ToolDefinition } from '@/lib/types';

export const tools: ToolDefinition[] = [
  {
    name: 'analyze_image',
    description:
      'Analyze an image using a vision-capable LLM. Use when the user asks you to look at, describe, analyze, or answer questions about an image. Can read images from the workspace, a URL, raw base64 data, or a previously generated image by ID. To look closer at a detail, call it again with region (e.g. "lower left"), which zooms into that part of the original.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'What to analyze or describe about the image (e.g. "Describe this image in detail", "What objects are visible?", "Read the text in this image")',
        },
        image_path: {
          type: 'string',
          description: 'Relative path to an image file in the workspace (e.g. "photos/sample.png")',
        },
        image_url: {
          type: 'string',
          description: 'URL of an image to analyze (will be fetched and base64-encoded)',
        },
        image_base64: {
          type: 'string',
          description: 'Raw base64-encoded image data',
        },
        image_id: {
          type: 'string',
          description: 'ID of a previously generated image (from generate_image result). Use this to analyze your own generated images.',
        },
        mime_type: {
          type: 'string',
          description: 'MIME type of the image (default: auto-detected or image/png)',
        },
        region: {
          type: 'string',
          description: 'Look closer at part of the image, cut from the full-resolution original: "top half", "lower left", "right third", "center", "top left quarter"; nest with ">" to zoom further ("lower left > top right"); or "x,y,w,h" fractions ("0.1,0.6,0.3,0.3"). When Donny says something is in the lower left, look there. Do NOT make enlarged or cropped copies yourself; use this.',
        },
      },
      required: ['prompt'],
    },
  },
];
