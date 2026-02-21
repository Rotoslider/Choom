import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import type { ToolCall, ToolResult } from '@/lib/types';
import prisma from '@/lib/db';

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
      const includeAudio = (toolCall.arguments.include_audio as boolean) ?? true;

      await prisma.notification.create({
        data: {
          choomId: ctx.choomId,
          message: notifMessage,
          includeAudio,
        },
      });

      console.log(`   🔔 Notification queued for choom ${ctx.choomId}: "${notifMessage.slice(0, 50)}..."`);
      return this.success(toolCall, {
        success: true,
        message: 'Notification queued for delivery via Signal.',
      });
    } catch (err) {
      console.error('   ❌ Notification error:', err instanceof Error ? err.message : err);
      return this.error(toolCall, `Failed to queue notification: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }
}
