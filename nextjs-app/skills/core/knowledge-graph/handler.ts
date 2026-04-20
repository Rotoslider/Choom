/**
 * Knowledge Graph skill handler — bridges Choom agents to ForgeRAG.
 *
 * Follows the same pattern as memory-management: tools dispatch to an
 * HTTP client that talks to the external ForgeRAG service on :8200.
 */

import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import type { ToolCall, ToolResult } from '@/lib/types';
import { ForgeRAGClient, executeForgeRAGTool } from '@/lib/forgerag-client';

const FORGERAG_TOOLS = new Set([
  'ask_engineering_question',
  'find_relevant_chunks',
  'search_engineering_docs',
  'query_knowledge_graph',
  'explore_entity',
  'list_knowledge_collections',
]);

function getEndpoint(): string {
  return process.env.FORGERAG_ENDPOINT || 'http://localhost:8200';
}

export default class KnowledgeGraphHandler extends BaseSkillHandler {
  canHandle(toolName: string): boolean {
    return FORGERAG_TOOLS.has(toolName);
  }

  async execute(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    const client = new ForgeRAGClient(getEndpoint());

    // Quick health check on first call to give a clear error if ForgeRAG is down
    try {
      const healthResult = await client.health();
      if (!healthResult.success) {
        return this.error(
          toolCall,
          `ForgeRAG service is not reachable at ${getEndpoint()}. ` +
            'Make sure the forgerag-api systemd service is running.'
        );
      }
    } catch (err) {
      return this.error(
        toolCall,
        `Cannot connect to ForgeRAG at ${getEndpoint()}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Dispatch to the tool executor
    const result = await executeForgeRAGTool(client, toolCall.name, toolCall.arguments);

    return {
      toolCallId: toolCall.id,
      name: toolCall.name,
      result: result.data ?? result,
      error: result.success ? undefined : result.reason,
    };
  }
}
