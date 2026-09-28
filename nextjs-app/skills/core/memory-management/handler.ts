import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import { ToolCall, ToolResult } from '@/lib/types';
import { executeMemoryTool } from '@/lib/memory-client';
import { renderHit, type ConversationHit } from '@/lib/recall-format';

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

// Tools whose result is a list of memories. Their raw form (~1,200 chars per
// memory: content plus tags, metadata, companion id, match type, raw score)
// made search_memories a ~9k-char result on every grounding turn. The compact
// form keeps what she reads — title, type, date, importance, the content —
// and drops the bookkeeping. `detail: true` returns the raw form.
//
// Content is kept WHOLE up to EXCERPT_CHARS. A 300-char excerpt was tried
// first (2026-09-12) and lost the detail she wakes up to string together:
// the "GENESIS + SISTERS nameplate" sat 380 chars into a 614-char memory, and
// DeepSeek ran three extra searches hunting for it. Genesis's memories run
// median 857 / p90 1,229 chars, so 1,500 keeps ~95% intact.
const LIST_TOOLS = new Set([
  'search_memories', 'search_by_type', 'search_by_tags', 'search_by_date_range', 'get_recent_memories',
]);
const EXCERPT_CHARS = 1500;
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
    // Local date AND time: on Sep 23 "canvas still in transit" (1:46 PM) and
    // "canvas on the wall" (5:16 PM) both read "2026-09-23", so she couldn't
    // tell which was newer.
    date: ts ? ts.slice(0, 16).replace('T', ' ') : undefined,
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

    // search_memories reads the conversation index: her memories plus her
    // private chats with Donny and her rooms (archived ones too), reranked and
    // tilted toward recent. On the recall benchmark a short lookup returned
    // the current truth 88% of the time vs 67% for memory-only search, and a
    // question 92% vs 40%. A room turn never sees private chats. If the index
    // is off or down, the memory store below answers exactly as before.
    if (toolCall.name === 'search_memories' && !wantDetail && typeof args.query === 'string' && args.query.trim()
        && typeof ctx.memoryClient.searchConversations === 'function') {
      const roomTurn = !!(ctx.isGroupTurn || ctx.groupRoomId);
      try {
        const conv = await ctx.memoryClient.searchConversations(args.query.trim(), ctx.choomId, {
          companionId: ctx.memoryCompanionId,
          roomTurn,
          limit: Math.min(Math.max(Number(args.limit) || DEFAULT_SEARCH_LIMIT, 1), 20),
          timeoutMs: 20000,
        });
        if (conv.success && Array.isArray(conv.data)) {
          const selfName = String((ctx.choom as { name?: unknown })?.name || '');
          const results = (conv.data as unknown as ConversationHit[]).map(h => renderHit(h, selfName, EXCERPT_CHARS));
          return {
            toolCallId: toolCall.id,
            name: toolCall.name,
            result: {
              success: true,
              count: results.length,
              results,
              note: `Best matches from your memories and ${roomTurn ? 'your rooms' : 'past conversations (private chats with Donny and your rooms)'}, each with who said it and when. When two disagree, the newer one usually wins — and weigh who said it.`,
            },
          };
        }
      } catch {
        // index unreachable — the memory store answers below
      }
    }

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
        ...(memories.some(m => m.truncated) ? { note: `Long memories are cut at ${EXCERPT_CHARS} chars — call again with detail=true for full text.` } : {}),
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
