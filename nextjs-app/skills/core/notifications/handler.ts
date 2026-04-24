import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import type { ToolCall, ToolResult } from '@/lib/types';
import prisma from '@/lib/db';
import { WORKSPACE_ROOT } from '@/lib/config';
import { existsSync } from 'fs';
import path from 'path';

const TOOL_NAMES = new Set([
  'send_notification',
  'heartbeat_complete',
]);

export default class NotificationsHandler extends BaseSkillHandler {
  canHandle(toolName: string): boolean {
    return TOOL_NAMES.has(toolName);
  }

  async execute(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    switch (toolCall.name) {
      case 'send_notification':
        return this.sendNotification(toolCall, ctx);
      case 'heartbeat_complete':
        return this.heartbeatComplete(toolCall, ctx);
      default:
        return this.error(toolCall, `Unknown notification tool: ${toolCall.name}`);
    }
  }

  private async heartbeatComplete(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    const summary = typeof toolCall.arguments.summary === 'string'
      ? toolCall.arguments.summary.trim()
      : '';
    if (!ctx.isHeartbeat) {
      return this.error(toolCall, 'heartbeat_complete can only be called during a heartbeat — ignored.');
    }
    console.log(`   💓 heartbeat_complete called | summary="${summary.slice(0, 80)}"`);
    return this.success(toolCall, { success: true, summary, stop: true });
  }

  private async sendNotification(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    try {
      const notifMessage = toolCall.arguments.message as string;
      const rawAudio = toolCall.arguments.include_audio;
      const includeAudio = rawAudio === false || rawAudio === 'false' || rawAudio === 'False' ? false : true;
      let imageIds = Array.isArray(toolCall.arguments.image_ids) ? toolCall.arguments.image_ids as string[] : [];

      // Resolve and validate file paths first — we check if the user is already
      // attaching images explicitly via file_paths before deciding to auto-attach.
      const rawFilePaths = Array.isArray(toolCall.arguments.file_paths)
        ? toolCall.arguments.file_paths as string[]
        : [];

      // Auto-attach recent images if the model didn't specify any. Conservative
      // heuristics prevent dumping stale snapshots from earlier in the session:
      //   - Explicit image_ids → use exactly those, no auto-attach.
      //   - file_paths already contains image files → user is being explicit, skip.
      //   - skip_auto_attach: true → caller opted out.
      //   - Otherwise attach at most 2 images from the last 90 seconds.
      const skipAutoAttach = toolCall.arguments.skip_auto_attach === true;
      const IMAGE_EXT_RE = /\.(?:jpg|jpeg|png|gif|webp|bmp)$/i;
      const filePathsHaveImage = rawFilePaths.some(p => typeof p === 'string' && IMAGE_EXT_RE.test(p));
      if (imageIds.length === 0 && ctx.choomId && !skipAutoAttach && !filePathsHaveImage) {
        const recentWindow = new Date(Date.now() - 90 * 1000);
        const recentImages = await prisma.generatedImage.findMany({
          where: { choomId: ctx.choomId, createdAt: { gte: recentWindow } },
          orderBy: { createdAt: 'desc' },
          take: 2,
          select: { id: true },
        });
        if (recentImages.length > 0) {
          imageIds = recentImages.map(img => img.id);
          console.log(`   📎 Auto-attached ${imageIds.length} recent image(s) from last 90s (choom ${ctx.choomId})`);
        }
      }
      const validFilePaths: string[] = [];
      const invalidPaths: string[] = [];

      for (const relPath of rawFilePaths) {
        if (typeof relPath !== 'string' || !relPath.trim()) continue;

        // Strip leading slashes to prevent absolute path injection
        const cleaned = relPath.replace(/^[/\\]+/, '');
        const absPath = path.resolve(WORKSPACE_ROOT, cleaned);

        // Path traversal check
        if (!absPath.startsWith(WORKSPACE_ROOT)) {
          invalidPaths.push(relPath + ' (outside workspace)');
          continue;
        }

        // Existence check
        if (!existsSync(absPath)) {
          invalidPaths.push(relPath + ' (not found)');
          continue;
        }

        validFilePaths.push(absPath);
      }

      await prisma.notification.create({
        data: {
          choomId: ctx.choomId,
          message: notifMessage,
          includeAudio,
          imageIds: imageIds.length > 0 ? JSON.stringify(imageIds) : null,
          filePaths: validFilePaths.length > 0 ? JSON.stringify(validFilePaths) : null,
        },
      });

      let statusMsg = 'Notification queued for delivery via Signal.';
      if (imageIds.length > 0) statusMsg += ` ${imageIds.length} image(s) attached.`;
      if (validFilePaths.length > 0) statusMsg += ` ${validFilePaths.length} file(s) attached.`;
      if (invalidPaths.length > 0) statusMsg += ` Skipped: ${invalidPaths.join(', ')}.`;

      console.log(`   🔔 Notification queued for choom ${ctx.choomId}: "${notifMessage.slice(0, 50)}..." (images: ${imageIds.length}, files: ${validFilePaths.length})`);
      return this.success(toolCall, { success: true, message: statusMsg });
    } catch (err) {
      console.error('   ❌ Notification error:', err instanceof Error ? err.message : err);
      return this.error(toolCall, `Failed to queue notification: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }
}
