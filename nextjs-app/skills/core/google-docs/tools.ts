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
      'Read the full text content of a GOOGLE DOCS document (not a workspace file) by its Google Drive ID. The ID is an opaque alphanumeric string like "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms" from the document URL — NOT a file path. To read a local workspace file like "my_project/notes.md", use workspace_read_file instead.',
    parameters: {
      type: 'object',
      properties: {
        document_id: {
          type: 'string',
          description: 'Google Docs document ID (opaque alphanumeric string from the URL, e.g. "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms"). NOT a file path — do not pass paths containing slashes or extensions like ".md", ".txt".',
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
