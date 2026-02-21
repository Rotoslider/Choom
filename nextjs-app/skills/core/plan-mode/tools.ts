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
          description: 'Array of plan steps. Each step: { description, toolName, args, dependsOn? }. Use {{step_N.result.field}} in args to reference previous step outputs.',
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
          description: 'Array of modifications: { stepId, action: "modify"|"skip"|"add", newArgs?, newStep? }',
        },
      },
      required: ['plan_id', 'modifications'],
    },
  },
];
