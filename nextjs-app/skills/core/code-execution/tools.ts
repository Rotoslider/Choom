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
      'Run a shell command inside a project workspace folder. Use for file operations, running scripts, or any CLI tool. Use run_ssh_command, not this tool, for remote SSH access. Python venvs are auto-activated if present.',
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
  {
    name: 'run_ssh_command',
    description:
      'Run a non-interactive command on a remote computer through this machine\'s OpenSSH client. Available only when this Choom\'s Remote SSH permission is enabled. Uses existing SSH keys and known hosts; never request or send passwords.',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'SSH target, such as "developer@192.0.2.42" or a configured SSH host alias',
        },
        command: {
          type: 'string',
          description: 'Non-interactive shell command to execute on the remote computer',
        },
        port: {
          type: 'number',
          description: 'Optional SSH port (default 22)',
        },
        timeout_seconds: {
          type: 'number',
          description: 'Execution timeout in seconds (default 330, max 600)',
        },
      },
      required: ['target', 'command'],
    },
  },
];
