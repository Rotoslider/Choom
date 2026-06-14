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

          // Safety net: if the LLM passes a workspace file path instead of a
          // Google Docs ID, redirect it to workspace_read_file. Google Docs
          // IDs are opaque alphanumeric strings (no slashes, no file extensions);
          // anything containing "/" or ending in a common extension is clearly
          // a local file path and the Google API would return a cryptic 404.
          const looksLikePath = /[\\/]|\.(?:md|txt|py|ts|tsx|js|jsx|json|yaml|yml|html|css|csv|log|sh|sql|xml|toml|ini|cfg)$/i.test(documentId || '');
          if (looksLikePath) {
            return this.error(
              toolCall,
              `"${documentId}" looks like a workspace file path, not a Google Docs document ID. Use workspace_read_file with path="${documentId}" instead. read_document only accepts opaque Google Drive IDs like "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms".`
            );
          }

          // Shape check: real Google Drive IDs are opaque ≥25-char strings of
          // [A-Za-z0-9_-] with no spaces. A short string or one with spaces is a
          // document NAME (or a guess), which the Docs API answers with a cryptic
          // 404. Catch it here and point at the lookup tools instead of guessing.
          if (!/^[A-Za-z0-9_-]{25,}$/.test(documentId || '')) {
            return this.error(
              toolCall,
              `"${documentId}" is not a valid Google Docs ID (IDs are opaque ≥25-char strings like "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms"). If you only have the document's NAME, call list_documents() (or search_drive("${documentId}")) first and pass the id from the result. Do not guess document IDs.`
            );
          }

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
      const msg = err instanceof Error ? err.message : 'Unknown error';
      // A 404 from the Docs API means the ID is well-formed but doesn't resolve:
      // wrong account, deleted doc, or an ID that points at a non-Doc Drive file
      // (Sheet/PDF/folder). Tell the model how to recover instead of looping.
      if (/\b404\b|not\s+found/i.test(msg) && (toolCall.name === 'read_document' || toolCall.name === 'append_to_document')) {
        return this.error(
          toolCall,
          `${toolCall.name} got a 404 — that ID doesn't resolve to a Google Doc on this account. It may be deleted, owned by another account, or actually a Sheet/PDF/folder (not a Doc). Call list_documents() to get a valid id, or search_drive("<name>") and check the result's mimeType is "application/vnd.google-apps.document". Do not retry the same id.`
        );
      }
      return this.error(toolCall, `Failed ${toolCall.name}: ${msg}`);
    }
  }
}
