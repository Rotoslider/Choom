import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import { ToolCall, ToolResult } from '@/lib/types';
import { executeMemoryTool } from '@/lib/memory-client';

const MEMORY_TOOLS = new Set([
  'remember',
  'search_memories',
  'search_by_type',
  'search_by_tags',
  'search_by_date_range',
  'get_recent_memories',
  'update_memory',
  'delete_memory',
  'get_memory_stats',
]);

// Tools whose result is a list of memories. Their raw form (~850 chars per
// memory: full content, tags, metadata, companion id, match type, raw score)
// made search_memories a ~9k-char result on every grounding turn. The compact
// form keeps what she reads — title, type, date, importance, a 300-char
// excerpt — and drops the bookkeeping. `detail: true` returns the raw form.
const LIST_TOOLS = new Set([
  'search_memories', 'search_by_type', 'search_by_tags', 'search_by_date_range', 'get_recent_memories',
]);
const EXCERPT_CHARS = 300;
const DEFAULT_SEARCH_LIMIT = 5;

type RawMemory = Record<string, unknown>;

export function compactMemory(m: RawMemory): Record<string, unknown> {
  const content = typeof m.content === 'string' ? m.content.replace(/\s+/g, ' ').trim() : '';
  const truncated = content.length > EXCERPT_CHARS;
  const ts = typeof m.timestamp === 'string' ? m.timestamp : '';
  const score = Number(m.relevance_score);
  return {
    id: m.id,
    ...(m.title ? { title: m.title } : {}),
    type: m.memory_type,
    date: ts ? ts.slice(0, 10) : undefined,
    importance: m.importance !== undefined ? Number(m.importance) : undefined,
    ...(Number.isFinite(score) ? { relevance: Math.round(score * 100) / 100 } : {}),
    excerpt: truncated ? content.slice(0, EXCERPT_CHARS - 1) + '…' : content,
    ...(truncated ? { truncated: true } : {}),
  };
}

export default class MemoryManagementHandler extends BaseSkillHandler {
  canHandle(toolName: string): boolean {
    return MEMORY_TOOLS.has(toolName);
  }

  async execute(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    const args = { ...toolCall.arguments };
    const wantDetail = args.detail === true;
    if (toolCall.name === 'search_memories' && !args.limit) args.limit = DEFAULT_SEARCH_LIMIT;

    const memoryResult = await executeMemoryTool(
      ctx.memoryClient,
      toolCall.name,
      args,
      ctx.memoryCompanionId
    );

    let result: unknown = memoryResult;
    if (memoryResult.success && LIST_TOOLS.has(toolCall.name) && Array.isArray(memoryResult.data) && !wantDetail) {
      const memories = (memoryResult.data as RawMemory[]).map(compactMemory);
      result = {
        success: true,
        count: memories.length,
        memories,
        ...(memories.some(m => m.truncated) ? { note: 'Excerpts are cut at 300 chars — call again with detail=true for full text.' } : {}),
      };
    }

    return {
      toolCallId: toolCall.id,
      name: toolCall.name,
      result,
      error: memoryResult.success ? undefined : memoryResult.reason,
    };
  }
}
