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

export default class MemoryManagementHandler extends BaseSkillHandler {
  canHandle(toolName: string): boolean {
    return MEMORY_TOOLS.has(toolName);
  }

  async execute(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    const memoryResult = await executeMemoryTool(
      ctx.memoryClient,
      toolCall.name,
      toolCall.arguments,
      ctx.memoryCompanionId
    );

    return {
      toolCallId: toolCall.id,
      name: toolCall.name,
      result: memoryResult,
      error: memoryResult.success ? undefined : memoryResult.reason,
    };
  }
}
