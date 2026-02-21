import type { ToolDefinition } from '@/lib/types';

export const tools: ToolDefinition[] = [
  {
    name: 'list_drive_files',
    description:
      'List files in Google Drive. Optionally filter by folder ID.',
    parameters: {
      type: 'object',
      properties: {
        folder_id: {
          type: 'string',
          description: 'Optional folder ID to list contents of. Omit for root.',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of files to return (default 20).',
        },
      },
    },
  },
  {
    name: 'search_drive',
    description:
      'Search Google Drive for files matching a query string.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query string (file name or content keywords).',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of results to return (default 20).',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'create_drive_folder',
    description:
      'Create a new folder in Google Drive.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the new folder.',
        },
        parent_id: {
          type: 'string',
          description: 'Optional parent folder ID. Omit to create in root.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'upload_to_drive',
    description:
      'Upload a file from the workspace to Google Drive. Path is relative to workspace root.',
    parameters: {
      type: 'object',
      properties: {
        workspace_path: {
          type: 'string',
          description: 'Workspace-relative path to the file to upload, e.g. "project/report.pdf".',
        },
        folder_id: {
          type: 'string',
          description: 'Optional Drive folder ID to upload into.',
        },
        drive_filename: {
          type: 'string',
          description: 'Optional filename to use in Drive (defaults to original filename).',
        },
      },
      required: ['workspace_path'],
    },
  },
  {
    name: 'download_from_drive',
    description:
      'Download a file from Google Drive to the workspace. Google Docs are exported as plain text, Sheets as CSV.',
    parameters: {
      type: 'object',
      properties: {
        file_id: {
          type: 'string',
          description: 'The Drive file ID to download.',
        },
        workspace_path: {
          type: 'string',
          description: 'Workspace-relative path to save the file to, e.g. "downloads/data.csv".',
        },
      },
      required: ['file_id', 'workspace_path'],
    },
  },
];
