import type { ToolDefinition } from '@/lib/types';

export const tools: ToolDefinition[] = [
  {
    name: 'list_documents',
    description:
      'List Google Documents accessible to the user. Returns name and URL for each document.',
    parameters: {
      type: 'object',
      properties: {
        max_results: {
          type: 'number',
          description: 'Maximum number of documents to return (default 20).',
        },
      },
    },
  },
  {
    name: 'create_document',
    description:
      'Create a new Google Document. Optionally provide initial plain-text content.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Title of the new document.',
        },
        content: {
          type: 'string',
          description: 'Optional plain-text content to populate the document with.',
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'read_document',
    description:
      'Read the full text content of a Google Document by its ID.',
    parameters: {
      type: 'object',
      properties: {
        document_id: {
          type: 'string',
          description: 'The document ID (from the URL or a previous create/list call).',
        },
      },
      required: ['document_id'],
    },
  },
  {
    name: 'append_to_document',
    description:
      'Append text to the end of an existing Google Document.',
    parameters: {
      type: 'object',
      properties: {
        document_id: {
          type: 'string',
          description: 'The document ID to append to.',
        },
        text: {
          type: 'string',
          description: 'Plain text to append to the document.',
        },
      },
      required: ['document_id', 'text'],
    },
  },
];
