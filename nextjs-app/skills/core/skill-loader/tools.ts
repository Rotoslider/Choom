import type { ToolDefinition } from '@/lib/types';

// The per-request definition (with the live skill list in the enum) is built by
// openSkillToolDefinition() in lib/tool-exposure.ts; this is the registry's
// static shape. In `full` exposure the tool is stripped — every tool is
// already loaded.
export const tools: ToolDefinition[] = [
  {
    name: 'open_skill',
    description:
      'Load another skill\'s tools for this conversation and read its instructions. Only some tools are loaded at a time; the AVAILABLE SKILLS list shows which skill holds which tool.',
    parameters: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: 'Skill name exactly as listed under AVAILABLE SKILLS' },
      },
      required: ['skill'],
    },
  },
];
