/**
 * Knowledge Graph skill handler — bridges Choom agents to ForgeRAG.
 *
 * Follows the same pattern as memory-management: tools dispatch to an
 * HTTP client that talks to the external ForgeRAG service on :8200.
 */

import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import type { ToolCall, ToolResult } from '@/lib/types';
import { ForgeRAGClient, executeForgeRAGTool } from '@/lib/forgerag-client';
import { WorkspaceService } from '@/lib/workspace-service';
import { WORKSPACE_ROOT } from '@/lib/config';
import prisma from '@/lib/db';

const FORGERAG_TOOLS = new Set([
  'ask_engineering_question',
  'find_relevant_chunks',
  'search_engineering_docs',
  'query_knowledge_graph',
  'explore_entity',
  'list_knowledge_collections',
  'smart_search',
  'get_forgerag_status',
  'get_page_image',
]);

const PAGE_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png'];
// Reduced page JPEGs run 200-600KB; full-res PNGs can be several MB.
const MAX_PAGE_IMAGE_KB = 8192;

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

    // get_page_image needs ctx (workspace + session file budget), so it is
    // handled here rather than in the client dispatcher.
    if (toolCall.name === 'get_page_image') {
      return this.getPageImage(toolCall, ctx);
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

  /**
   * Fetch a ForgeRAG page image server-side and save it into the Choom's
   * workspace so analyze_image(image_path=...) can inspect it.
   *
   * ForgeRAG search results carry RELATIVE image links (/images/{hash}/{pn})
   * on an internal service the outbound guard rightly refuses to let
   * model-controlled fetches reach — the guard's own design says internal
   * services get dedicated tools instead (like ha_get_camera_snapshot).
   * This is that dedicated tool for ForgeRAG pages.
   */
  private async getPageImage(
    toolCall: ToolCall,
    ctx: SkillHandlerContext
  ): Promise<ToolResult> {
    const args = toolCall.arguments as Record<string, unknown>;
    let hash = args.file_hash ? String(args.file_hash) : '';
    let page = args.page_number ? Number(args.page_number) : NaN;

    // Also accept the image_url string exactly as search results return it
    // ("/images/{hash}/{pn}" or ".../{pn}/reduced") — least friction for
    // the model.
    const imageUrl = args.image_url ? String(args.image_url) : '';
    if ((!hash || !Number.isFinite(page)) && imageUrl) {
      const m = imageUrl.match(/\/images\/([0-9a-f]{16,64})\/(\d+)/i);
      if (m) {
        hash = hash || m[1];
        page = Number.isFinite(page) ? page : Number(m[2]);
      }
    }
    if (!hash || !Number.isFinite(page) || page < 1) {
      return this.error(
        toolCall,
        'Provide file_hash + page_number, or the image_url string from a ' +
          'search result (e.g. "/images/<hash>/<page>").'
      );
    }

    const { sessionFileCount } = ctx;
    if (sessionFileCount.created >= sessionFileCount.maxAllowed) {
      return this.error(
        toolCall,
        `Session file limit reached (${sessionFileCount.maxAllowed}). Cannot save more files.`
      );
    }

    // Reduced JPEG first (right size for vision), full PNG as fallback.
    let buffer: Buffer | null = null;
    let ext = '.jpg';
    for (const [suffix, extension] of [['/reduced', '.jpg'], ['', '.png']] as const) {
      try {
        const resp = await fetch(`${getEndpoint()}/images/${hash}/${page}${suffix}`);
        if (resp.ok) {
          buffer = Buffer.from(await resp.arrayBuffer());
          ext = extension;
          break;
        }
      } catch {
        // fall through to the next variant
      }
    }
    if (!buffer || buffer.length === 0) {
      return this.error(
        toolCall,
        `ForgeRAG has no image for page ${page} of document hash ${hash.slice(0, 12)}… ` +
          '(check the hash/page from the search result).'
      );
    }

    const savePath = `forgerag_pages/${hash.slice(0, 12)}_p${String(page).padStart(4, '0')}${ext}`;
    const ws = new WorkspaceService(WORKSPACE_ROOT, MAX_PAGE_IMAGE_KB, PAGE_IMAGE_EXTENSIONS);
    await ws.writeFileBuffer(savePath, buffer, PAGE_IMAGE_EXTENSIONS);
    sessionFileCount.created++;
    ctx.send({ type: 'file_created', path: savePath });

    // show_user: display the page inline in the chat (and make it
    // Signal-able) — same GeneratedImage + image_generated pattern as
    // camera snapshots. Off by default so a Choom privately reading ten
    // pages doesn't flood the conversation; set true when the user asks
    // to SEE a page.
    let savedImageId: string | undefined;
    if (args.show_user === true) {
      try {
        const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
        const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
        const savedImage = await prisma.generatedImage.create({
          data: {
            choomId: ctx.choomId,
            prompt: `ForgeRAG page ${page} (doc ${hash.slice(0, 12)}…)`,
            imageUrl: dataUrl,
            settings: JSON.stringify({
              source: 'forgerag_page', file_hash: hash,
              page_number: page, path: savePath,
            }),
          },
        });
        savedImageId = savedImage.id;
        ctx.send({
          type: 'image_generated',
          imageUrl: dataUrl,
          imageId: savedImage.id,
          prompt: `ForgeRAG page ${page}`,
        });
      } catch (persistErr) {
        console.warn(
          '   ⚠️ Page image saved to workspace but chat display failed:',
          persistErr instanceof Error ? persistErr.message : persistErr,
        );
      }
    }

    return {
      toolCallId: toolCall.id,
      name: toolCall.name,
      result: {
        saved_path: savePath,
        page_number: page,
        size_kb: Math.round(buffer.length / 1024),
        ...(savedImageId ? { imageId: savedImageId, displayed_in_chat: true } : {}),
        next_step:
          `Page image saved. Call analyze_image with image_path="${savePath}" ` +
          'to visually inspect it.' +
          (savedImageId
            ? ' The page is displayed in the chat.'
            : ' If the user asked to SEE this page, call get_page_image again with show_user=true.') +
          ` To text it over Signal, use send_notification(file_paths=["${savePath}"]).`,
      },
    };
  }
}
