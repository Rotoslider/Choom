import type { ToolDefinition } from '@/lib/types';

export const tools: ToolDefinition[] = [
  {
    name: 'generate_image',
    description:
      'Generate an image using Stable Diffusion. Use when the user requests an image, picture, or artwork. Use self_portrait mode when generating an image of yourself.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Detailed description of the image to generate. For self-portraits, describe the scene, pose, expression, and setting.',
        },
        self_portrait: {
          type: 'boolean',
          description: 'Set to true when generating a picture of yourself/the AI companion. Uses your character-specific settings.',
        },
        negative_prompt: {
          type: 'string',
          description: 'Things to avoid in the image (optional, uses defaults if not specified)',
        },
        size: {
          type: 'string',
          description: 'Image size preset: "small" (768px), "medium" (1024px), "large" (1536px), "x-large" (1856px). Controls the longest dimension.',
          enum: ['small', 'medium', 'large', 'x-large'],
        },
        aspect: {
          type: 'string',
          description: 'Image aspect ratio: "portrait" (3:4), "portrait-tall" (9:16), "square" (1:1), "landscape" (16:9), "wide" (21:9). For self-portraits, prefer "portrait" or "portrait-tall".',
          enum: ['portrait', 'portrait-tall', 'square', 'landscape', 'wide'],
        },
        width: {
          type: 'number',
          description: 'Image width in pixels (optional, overrides size/aspect if set)',
        },
        height: {
          type: 'number',
          description: 'Image height in pixels (optional, overrides size/aspect if set)',
        },
        steps: {
          type: 'number',
          description: 'Number of generation steps (optional, uses mode defaults)',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'save_generated_image',
    description:
      'Save a previously generated image to a project workspace folder. Use after generate_image to persist the image as a file.',
    parameters: {
      type: 'object',
      properties: {
        image_id: {
          type: 'string',
          description: 'The image ID returned by generate_image (the imageId field from the result)',
        },
        save_path: {
          type: 'string',
          description: 'Relative path in the workspace to save the image (e.g. "my_project/images/sunset.png"). Must end with an image extension (.png, .jpg, .jpeg, .gif, .webp, .bmp).',
        },
      },
      required: ['image_id', 'save_path'],
    },
  },
];
