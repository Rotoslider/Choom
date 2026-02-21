import type { ToolDefinition } from '@/lib/types';

export const tools: ToolDefinition[] = [
  {
    name: 'workspace_generate_pdf',
    description:
      'Generate a PDF from markdown content or a markdown file. Supports headers, lists, code blocks, and embedded images via ![caption](path) syntax or an explicit images array.',
    parameters: {
      type: 'object',
      properties: {
        output_path: {
          type: 'string',
          description: 'Relative output path for the PDF (e.g. "my_project/report.pdf")',
        },
        source_path: {
          type: 'string',
          description: 'Relative path to a markdown file to convert (optional if content is provided)',
        },
        content: {
          type: 'string',
          description: 'Markdown content to convert (optional if source_path is provided)',
        },
        title: {
          type: 'string',
          description: 'Optional title for the PDF cover/header',
        },
        images: {
          type: 'array',
          description: 'Optional array of images to embed in the PDF',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Relative path to image file in workspace' },
              width: { type: 'number', description: 'Max width in points (optional, fits page by default)' },
              caption: { type: 'string', description: 'Caption text below the image (optional)' },
            },
            required: ['path'],
          },
        },
      },
      required: ['output_path'],
    },
  },
  {
    name: 'workspace_read_pdf',
    description:
      'Extract text content from a PDF file in the workspace. For large PDFs, use page_start/page_end to read specific sections.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path to the PDF file in the workspace',
        },
        page_start: {
          type: 'number',
          description: 'First page to extract (1-based, optional)',
        },
        page_end: {
          type: 'number',
          description: 'Last page to extract (1-based, optional)',
        },
      },
      required: ['path'],
    },
  },
];
