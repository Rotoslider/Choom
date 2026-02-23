import type { ToolDefinition } from '@/lib/types';

export const tools: ToolDefinition[] = [
  {
    name: 'workspace_write_file',
    description:
      'Write or overwrite a file in the project workspace. Supports .md, .txt, .json, .py, .ts, .js, .html, .css, .csv extensions. Parent directories are created automatically.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path within the workspace (e.g. "my_project/notes.md")',
        },
        content: {
          type: 'string',
          description: 'File content to write',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'workspace_read_file',
    description:
      'Read the contents of a file in the project workspace. Returns the full text content.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path within the workspace (e.g. "my_project/notes.md")',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'workspace_list_files',
    description:
      'List files and folders in the project workspace. Shows file sizes and types. Omit path to list all projects at root level.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative directory path to list (omit for workspace root)',
        },
      },
    },
  },
  {
    name: 'workspace_create_folder',
    description:
      'Create a new folder (and any parent directories) in the project workspace. Use underscores instead of spaces.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative folder path to create (e.g. "my_project/subfolder")',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'workspace_delete_file',
    description:
      'Delete a file from the project workspace. Cannot delete directories — only files.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path of the file to delete',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'workspace_create_project',
    description:
      'Create a new project with a folder and .choom-project.json metadata file. Use this BEFORE writing any project files. The project will appear in the Projects tab.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Project name in snake_case (e.g. "react_server_components", "email_validator"). Used as the folder name.',
        },
        description: {
          type: 'string',
          description: 'Brief description of the project goal',
        },
        assigned_choom: {
          type: 'string',
          description: 'Name of the Choom managing this project (e.g. "Aloy")',
        },
      },
      required: ['name', 'description'],
    },
  },
  {
    name: 'workspace_rename_project',
    description:
      'Rename a project folder in the workspace. Updates the folder name and project metadata.',
    parameters: {
      type: 'object',
      properties: {
        old_name: {
          type: 'string',
          description: 'Current project folder name',
        },
        new_name: {
          type: 'string',
          description: 'New project name (spaces will be converted to underscores)',
        },
      },
      required: ['old_name', 'new_name'],
    },
  },
];
