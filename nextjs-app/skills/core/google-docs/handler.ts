import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import { ToolCall, ToolResult } from '@/lib/types';
import { getGoogleClient } from '@/lib/google-client';

const DOCS_TOOLS = new Set([
  'list_documents',
  'create_document',
  'read_document',
  'append_to_document',
]);

export default class GoogleDocsHandler extends BaseSkillHandler {
  canHandle(toolName: string): boolean {
    return DOCS_TOOLS.has(toolName);
  }

  async execute(toolCall: ToolCall, _ctx: SkillHandlerContext): Promise<ToolResult> {
    try {
      const googleClient = getGoogleClient();

      switch (toolCall.name) {
        case 'list_documents': {
          const maxResults = (toolCall.arguments.max_results as number) || 20;
          const documents = await googleClient.listDocuments(maxResults);

          const formatted = documents.length === 0
            ? 'No documents found.'
            : documents.map((d) => `- ${d.name} (${d.url})`).join('\n');

          console.log(`   [docs] Documents: ${documents.length} found`);

          return this.success(toolCall, { success: true, documents, formatted, count: documents.length });
        }

        case 'create_document': {
          const title = toolCall.arguments.title as string;
          const content = toolCall.arguments.content as string | undefined;
          const result = await googleClient.createDocument(title, content);

          console.log(`   [docs] Created document: "${title}" (${result.id})`);

          return this.success(toolCall, {
            success: true,
            document: result,
            message: `Created document "${title}". URL: ${result.url}`,
          });
        }

        case 'read_document': {
          const documentId = toolCall.arguments.document_id as string;
          const result = await googleClient.readDocument(documentId);

          console.log(`   [docs] Read document: "${result.title}" (${result.content.length} chars)`);

          return this.success(toolCall, { success: true, ...result });
        }

        case 'append_to_document': {
          const documentId = toolCall.arguments.document_id as string;
          const text = toolCall.arguments.text as string;
          const result = await googleClient.appendToDocument(documentId, text);

          console.log(`   [docs] Appended ${text.length} chars to document ${documentId}`);

          return this.success(toolCall, {
            success: true,
            ...result,
            message: `Appended ${text.length} characters to document.`,
          });
        }

        default:
          return this.error(toolCall, `Unknown tool: ${toolCall.name}`);
      }
    } catch (err) {
      return this.error(
        toolCall,
        `Failed ${toolCall.name}: ${err instanceof Error ? err.message : 'Unknown error'}`
      );
    }
  }
}
