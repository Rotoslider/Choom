import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import type { ToolCall, ToolResult } from '@/lib/types';
import { getSkillRegistry } from '@/lib/skill-registry';

const DOC_CAP = 6000;

/**
 * open_skill: returns the skill's tool names and instructions. The agentic
 * loop watches for a successful result and adds the skill's tool definitions
 * to the turn's tool set (lib/agentic-loop.ts) — the handler itself cannot
 * reach the loop's tool array.
 */
export default class SkillLoaderHandler extends BaseSkillHandler {
  canHandle(toolName: string): boolean {
    return toolName === 'open_skill';
  }

  async execute(toolCall: ToolCall, _ctx: SkillHandlerContext): Promise<ToolResult> {
    const raw = String(toolCall.arguments.skill ?? toolCall.arguments.name ?? '').trim();
    if (!raw) return this.error(toolCall, 'skill is required — the skill name as listed under AVAILABLE SKILLS');
    const registry = getSkillRegistry();
    const wanted = raw.toLowerCase().replace(/[\s_]+/g, '-');
    const skill = registry.getSkill(wanted) ?? registry.getSkillNames()
      .map(n => registry.getSkill(n)!)
      .find(s => s.metadata.name.toLowerCase() === wanted || s.toolDefinitions.some(t => t.name === raw));
    if (!skill) {
      return this.error(toolCall, `No skill named "${raw}". Skills: ${registry.getSkillNames().join(', ')}`);
    }
    if (skill.metadata.name === 'skill-loader') {
      return this.error(toolCall, 'open_skill is already loaded — name the skill whose tools you need.');
    }
    const doc = (skill.fullDoc || '').trim();
    return this.success(toolCall, {
      success: true,
      skill: skill.metadata.name,
      tools_loaded: skill.toolDefinitions.map(t => t.name),
      instructions: doc.length > DOC_CAP ? doc.slice(0, DOC_CAP) + '\n…(instructions truncated)' : doc,
      note: 'These tools are now available for the rest of this turn. Call the one you need.',
    });
  }
}
