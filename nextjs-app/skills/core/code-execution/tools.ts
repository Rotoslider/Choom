import type { ToolDefinition } from '@/lib/types';

export const tools: ToolDefinition[] = [
  {
    name: 'execute_code',
    description:
      'Execute Python or Node.js code in a sandboxed project workspace. Use when the user asks to run code, test a script, or execute a snippet. Create a venv/project first if packages are needed.',
    parameters: {
      type: 'object',
      properties: {
        project_folder: {
          type: 'string',
          description: 'Project folder name within the workspace (e.g. "my-project")',
        },
        language: {
          type: 'string',
          description: 'Programming language to execute',
          enum: ['python', 'node'],
        },
        code: {
          type: 'string',
          description: 'The code to execute',
        },
        timeout_seconds: {
          type: 'number',
          description: 'Execution timeout in seconds (default 30, max 120)',
        },
      },
      required: ['project_folder', 'language', 'code'],
    },
  },
  {
    name: 'create_venv',
    description:
      'Create a Python virtual environment or initialize a Node.js project in a workspace folder. Do this BEFORE installing packages. Use when setting up a new coding project.',
    parameters: {
      type: 'object',
      properties: {
        project_folder: {
          type: 'string',
          description: 'Project folder name within the workspace (e.g. "my-project")',
        },
        runtime: {
          type: 'string',
          description: 'Runtime to initialize',
          enum: ['python', 'node'],
        },
      },
      required: ['project_folder', 'runtime'],
    },
  },
  {
    name: 'install_package',
    description:
      'Install packages into a project\'s virtual environment (pip) or node_modules (npm). The project must already have a venv or package.json — use create_venv first if needed.',
    parameters: {
      type: 'object',
      properties: {
        project_folder: {
          type: 'string',
          description: 'Project folder name within the workspace (e.g. "my-project")',
        },
        runtime: {
          type: 'string',
          description: 'Package manager runtime',
          enum: ['python', 'node'],
        },
        packages: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of package names to install (e.g. ["requests", "numpy"])',
        },
      },
      required: ['project_folder', 'runtime', 'packages'],
    },
  },
  {
    name: 'run_command',
    description:
      'Run a shell command inside a project workspace folder. Use for file operations, running scripts, or any CLI tool. Python venvs are auto-activated if present.',
    parameters: {
      type: 'object',
      properties: {
        project_folder: {
          type: 'string',
          description: 'Project folder name within the workspace (e.g. "my-project")',
        },
        command: {
          type: 'string',
          description: 'Shell command to execute',
        },
        timeout_seconds: {
          type: 'number',
          description: 'Execution timeout in seconds (default 30, max 120)',
        },
      },
      required: ['project_folder', 'command'],
    },
  },
];
