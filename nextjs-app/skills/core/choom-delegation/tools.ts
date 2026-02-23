import type { ToolDefinition } from '@/lib/types';

export const tools: ToolDefinition[] = [
  {
    name: 'delegate_to_choom',
    description:
      'Send a task to another Choom and get their response. The target Choom processes the task using its own model, system prompt, and tools. Use for orchestrating multi-agent collaboration — e.g., ask a researcher Choom to investigate a topic, or a coder Choom to write a function.',
    parameters: {
      type: 'object',
      properties: {
        choom_name: {
          type: 'string',
          description: 'Name of the target Choom (e.g., "Genesis", "Anya", "Optic"). Use list_team to see available names.',
        },
        task: {
          type: 'string',
          description: 'Clear task description for the target Choom. Be direct and specific about what you need — don\'t add unnecessary elaboration. Example: "Check the current weather in Rodeo, NM" not "Research and analyze weather patterns". Include constraints and desired output format when relevant.',
        },
        context: {
          type: 'string',
          description: 'Optional additional context from the project or previous delegations. Include relevant results from prior steps.',
        },
        timeout_seconds: {
          type: 'number',
          description: 'Max seconds to wait for response (default 120, max 300).',
        },
      },
      required: ['choom_name', 'task'],
    },
  },
  {
    name: 'list_team',
    description:
      'List all available Chooms that can receive delegated tasks. Shows each Choom\'s name, description, model, and specialization based on their system prompt.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_delegation_result',
    description:
      'Retrieve the result of a previous delegation by its ID. Use when you need to re-read a result from an earlier delegation.',
    parameters: {
      type: 'object',
      properties: {
        delegation_id: {
          type: 'string',
          description: 'The delegation ID returned by delegate_to_choom',
        },
      },
      required: ['delegation_id'],
    },
  },
];
