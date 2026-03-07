import type { ToolDefinition } from '@/lib/types';

export const tools: ToolDefinition[] = [
  {
    name: 'create_plan',
    description:
      'Create a structured execution plan for a complex multi-step task. Define the goal and each step with its tool, arguments, and dependencies. Returns a plan_id for execution.',
    parameters: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description: 'Brief description of the overall goal',
        },
        steps: {
          type: 'array',
          description: 'Array of plan steps. Use {{step_N.result.field}} in args/task to reference previous step outputs.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Unique step ID, e.g. "step_1"' },
              type: { type: 'string', enum: ['tool', 'delegate'], description: '"tool" to call a tool directly, "delegate" to send task to another Choom' },
              description: { type: 'string', description: 'What this step does' },
              toolName: { type: 'string', description: 'Tool to call (for type "tool")' },
              args: { type: 'object', description: 'Arguments for the tool (for type "tool")' },
              choomName: { type: 'string', description: 'Target Choom name (for type "delegate")' },
              task: { type: 'string', description: 'Task description for the target Choom (for type "delegate")' },
              dependsOn: { type: 'array', items: { type: 'string' }, description: 'Step IDs that must complete first' },
            },
            required: ['id', 'type', 'description'],
          },
        },
      },
      required: ['goal', 'steps'],
    },
  },
  {
    name: 'execute_plan',
    description:
      'Execute a previously created plan step-by-step with automatic error handling (retry, skip, abort). Streams progress events to the client.',
    parameters: {
      type: 'object',
      properties: {
        plan_id: {
          type: 'string',
          description: 'The plan ID returned by create_plan',
        },
      },
      required: ['plan_id'],
    },
  },
  {
    name: 'adjust_plan',
    description:
      'Modify remaining steps of a plan that is mid-execution. Use after a step fails to skip, modify, or add steps.',
    parameters: {
      type: 'object',
      properties: {
        plan_id: {
          type: 'string',
          description: 'The plan ID to modify',
        },
        modifications: {
          type: 'array',
          description: 'Array of modifications to apply to the plan',
          items: {
            type: 'object',
            properties: {
              stepId: { type: 'string', description: 'ID of the step to modify' },
              action: { type: 'string', enum: ['modify', 'skip', 'add'], description: 'What to do' },
              newArgs: { type: 'object', description: 'New arguments (for action "modify")' },
              newStep: { type: 'object', description: 'New step definition (for action "add")' },
            },
            required: ['stepId', 'action'],
          },
        },
      },
      required: ['plan_id', 'modifications'],
    },
  },
];
