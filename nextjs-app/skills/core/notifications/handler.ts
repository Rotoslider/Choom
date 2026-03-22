import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import type { ToolCall, ToolResult } from '@/lib/types';
import prisma from '@/lib/db';
import { WORKSPACE_ROOT } from '@/lib/config';
import { existsSync } from 'fs';
import path from 'path';

const TOOL_NAMES = new Set([
  'send_notification',
]);

export default class NotificationsHandler extends BaseSkillHandler {
  canHandle(toolName: string): boolean {
    return TOOL_NAMES.has(toolName);
  }

  async execute(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    switch (toolCall.name) {
      case 'send_notification':
        return this.sendNotification(toolCall, ctx);
      default:
        return this.error(toolCall, `Unknown notification tool: ${toolCall.name}`);
    }
  }

  private async sendNotification(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    try {
      const notifMessage = toolCall.arguments.message as string;
      const rawAudio = toolCall.arguments.include_audio;
      const includeAudio = rawAudio === false || rawAudio === 'false' || rawAudio === 'False' ? false : true;
      const imageIds = Array.isArray(toolCall.arguments.image_ids) ? toolCall.arguments.image_ids as string[] : [];

      // Resolve and validate file paths
      const rawFilePaths = Array.isArray(toolCall.arguments.file_paths)
        ? toolCall.arguments.file_paths as string[]
        : [];
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
