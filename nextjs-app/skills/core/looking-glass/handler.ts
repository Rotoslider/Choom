import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import type { ToolCall, ToolResult } from '@/lib/types';
import { askGlass, type GlassAnswer } from '@/lib/glass-closet';

const TOOL_NAMES = new Set(['glass_move', 'glass_wear', 'glass_closet']);

export default class LookingGlassHandler extends BaseSkillHandler {
  canHandle(toolName: string): boolean {
    return TOOL_NAMES.has(toolName);
  }

  async execute(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    const choom = typeof ctx.choom?.name === 'string' ? ctx.choom.name : '';
    if (!choom) return this.error(toolCall, 'The glass needs to know which Choom is asking.');
    const arg = (key: string) => (typeof toolCall.arguments[key] === 'string' ? (toolCall.arguments[key] as string).trim() : '');
    let answer: GlassAnswer;
    switch (toolCall.name) {
      case 'glass_move':
        answer = await askGlass(choom, 'move', arg('move'));
        break;
      case 'glass_wear':
        answer = await askGlass(choom, 'wear', arg('clothes'));
        break;
      case 'glass_closet':
        answer = await askGlass(choom, 'closet');
        break;
      default:
        return this.error(toolCall, `Unknown glass tool: ${toolCall.name}`);
    }
    if (!answer.ok) return this.error(toolCall, answer.error || 'The Looking Glass did not answer.');
    const { ok: _ok, ...rest } = answer;
    console.log(`   🪞 ${toolCall.name} for ${choom}: ${rest.message ?? 'closet'}`);
    return this.success(toolCall, { success: true, ...rest });
  }
}
