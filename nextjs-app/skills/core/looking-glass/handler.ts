import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import type { ToolCall, ToolResult } from '@/lib/types';
import { askGlass, type GlassAnswer } from '@/lib/glass-closet';

const TOOL_NAMES = new Set(['glass_move', 'glass_wear', 'glass_closet', 'glass_wish']);
const MAX_WISHES = 12; // one call's worth; more can come in the next call

/**
 * The wishes in a glass_wish call: `wish`, and/or `wishes` (several at once, each its own wish on
 * Donny's list; Nov 5, 2026). A list sent as one string ("a, b" or one per line) is taken as it is:
 * a description can hold commas. Blank and repeated entries are dropped.
 */
export function wishesFromArgs(args: Record<string, unknown>): string[] {
  const all = [args.wish, ...(Array.isArray(args.wishes) ? args.wishes : [args.wishes])]
    .filter((w): w is string => typeof w === 'string')
    .map((w) => w.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  return all.filter((w) => !seen.has(w.toLowerCase()) && !!seen.add(w.toLowerCase()));
}

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
      case 'glass_wish':
        return this.wish(toolCall, choom);
      default:
        return this.error(toolCall, `Unknown glass tool: ${toolCall.name}`);
    }
    if (!answer.ok) return this.error(toolCall, answer.error || 'The Looking Glass did not answer.');
    const { ok: _ok, ...rest } = answer;
    console.log(`   🪞 ${toolCall.name} for ${choom}: ${rest.message ?? 'closet'}`);
    return this.success(toolCall, { success: true, ...rest });
  }

  /** Each wish goes to the glass on its own, one after another (they share one wishes.json there). */
  private async wish(toolCall: ToolCall, choom: string): Promise<ToolResult> {
    const all = wishesFromArgs(toolCall.arguments);
    if (!all.length) return this.error(toolCall, 'Say what you wish for: `wish` for one, `wishes` for several.');
    const kind = toolCall.arguments.kind === 'move' ? 'move' : 'wear';
    const asked = all.slice(0, MAX_WISHES);
    const added: string[] = [];
    const failed: string[] = [];
    for (const w of asked) {
      const answer = await askGlass(choom, 'wish', w, kind);
      if (!answer.ok) {
        failed.push(`"${w}": ${answer.error || 'the Looking Glass did not answer'}`);
        // The glass isn't running: the rest would fail the same way.
        if (/not running/i.test(answer.error || '')) {
          failed.push(...asked.slice(asked.indexOf(w) + 1).map((x) => `"${x}": not sent`));
          break;
        }
        continue;
      }
      added.push(answer.message || `"${w}" is on Donny's wish list in Glass Studio now.`);
      console.log(`   🪞 glass_wish for ${choom}: ${answer.message ?? w}`);
    }
    if (!added.length) return this.error(toolCall, failed.join(' '));
    if (all.length === 1 && !failed.length) return this.success(toolCall, { success: true, done: false, message: added[0] });
    const more = all.length - asked.length;
    return this.success(toolCall, {
      success: true,
      done: false,
      message: `${added.length} ${added.length === 1 ? 'wish is' : 'separate wishes are'} on Donny's wish list in Glass Studio now.` +
        (failed.length ? ` ${failed.length} didn't go on it; see not_added.` : '') +
        (more > 0 ? ` Only ${MAX_WISHES} go in one call: send the other ${more} in another.` : ''),
      added,
      ...(failed.length ? { not_added: failed } : {}),
    });
  }
}
