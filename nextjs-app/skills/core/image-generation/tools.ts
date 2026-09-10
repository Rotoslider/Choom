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
          description: 'Detailed description of the image to generate. Describe the scene, pose, expression, setting, clothing and mood. Do NOT describe the face, hair, eye colour or build of anyone listed in `references`, or of yourself in a self-portrait — the reference image supplies their likeness, and a conflicting description overrides it and produces the wrong person.',
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
          description: 'Image size preset: "small" (768px), "medium" (1024px), "large" (1536px), "x-large" (1856px), "xx-large" (2048px). Controls the longest dimension.',
          enum: ['small', 'medium', 'large', 'x-large', 'xx-large'],
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
        references: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Subjects from the shared reference library to condition the image on, so people, '
            + 'places and objects look the same across images. These are ALREADY LOADED and listed '
            + 'under "Available references" below — there are no files to find, and searching the '
            + 'workspace for character sheets or portraits will not find them. '
            + 'Use each name exactly as quoted; do not append _reference, _sheet or similar. '
            + 'e.g. ["genesis", "owner", "cabin-exterior"]. '
            + 'ORDER MATTERS: the first reference lands leftmost in the frame. Give EVERY person a '
            + 'seat from the VIEWER\'s point of view — "on the left", "in the middle", "on the right", '
            + '"standing behind" — never "on Aloy\'s left", which is ambiguous and is not read as a '
            + 'seat. Seating everyone is what gets the right face on the right person; with four '
            + 'people it is the difference between a family portrait and four strangers. '
            + 'Anyone you name in the prompt is attached automatically even if you leave them out '
            + 'here, and your own reference is attached on self-portraits — so the argument is a '
            + 'convenience, not a requirement. Omit it when nothing recurring is in the picture. '
            + 'Do NOT describe the face, hair, eye colour, skin or build of anyone referenced: the '
            + 'reference image supplies their likeness, and a conflicting description overrides it '
            + 'and produces the wrong person. Describe the scene, pose, clothing and mood instead.',
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
