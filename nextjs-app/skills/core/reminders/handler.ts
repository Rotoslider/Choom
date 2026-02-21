import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import type { ToolCall, ToolResult } from '@/lib/types';

const REMINDER_TOOLS = new Set([
  'create_reminder',
  'get_reminders',
]);

export default class RemindersHandler extends BaseSkillHandler {
  canHandle(toolName: string): boolean {
    return REMINDER_TOOLS.has(toolName);
  }

  async execute(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    switch (toolCall.name) {
      case 'get_reminders':
        return this.getReminders(toolCall);
      case 'create_reminder':
        return this.createReminder(toolCall);
      default:
        return this.error(toolCall, `Unknown reminder tool: ${toolCall.name}`);
    }
  }

  private async getReminders(toolCall: ToolCall): Promise<ToolResult> {
    try {
      const dateFilter = toolCall.arguments.date as string | undefined;
      const baseUrl = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
      const reminderRes = await fetch(`${baseUrl}/api/reminders`, { method: 'GET' });

      if (!reminderRes.ok) {
        throw new Error('Failed to fetch reminders');
      }

      let reminders = await reminderRes.json();

      // Optional date filter
      if (dateFilter) {
        const filterDate = dateFilter.slice(0, 10); // "2026-02-09"
        reminders = reminders.filter((r: { remind_at: string }) => {
          return r.remind_at && r.remind_at.startsWith(filterDate);
        });
      }

      const formatted = reminders.length === 0
        ? 'No pending reminders.'
        : reminders.map((r: { text: string; remind_at: string; id: string }) => {
            const time = new Date(r.remind_at).toLocaleString('en-US', {
              weekday: 'short', month: 'short', day: 'numeric',
              hour: 'numeric', minute: '2-digit', timeZone: 'America/Denver',
            });
            return `- "${r.text}" at ${time}`;
          }).join('\n');

      console.log(`   Get reminders: ${reminders.length} found`);

      return this.success(toolCall, { success: true, reminders, formatted, count: reminders.length });
    } catch (err) {
      console.error('   Get reminders failed:', err instanceof Error ? err.message : err);
      return this.error(toolCall, `Failed to get reminders: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  private async createReminder(toolCall: ToolCall): Promise<ToolResult> {
    try {
      let text = toolCall.arguments.text as string;
      const minutesFromNow = toolCall.arguments.minutes_from_now as number | undefined;
      const timeStr = toolCall.arguments.time as string | undefined;

      // Clean up text: strip stray time abbreviations like "1.m.", "a.m.", "p.m."
      text = text.replace(/\b\d+\.m\.\s*/gi, '').replace(/\b[ap]\.m\.\s*/gi, '').trim();

      let remindAt: Date;

      if (minutesFromNow) {
        remindAt = new Date(Date.now() + minutesFromNow * 60_000);
      } else if (timeStr) {
        const now = new Date();
        // Match "3:00 PM", "3:00PM", "3:00 pm"
        const match12 = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
        // Match "15:00"
        const match24 = timeStr.match(/^(\d{1,2}):(\d{2})$/);
        // Match bare "4pm", "4 PM", "4PM", "4 am" (no colon)
        const matchBare = timeStr.match(/^(\d{1,2})\s*(AM|PM)$/i);

        if (match12) {
          let hours = parseInt(match12[1]);
          const minutes = parseInt(match12[2]);
          const period = match12[3].toUpperCase();
          if (period === 'PM' && hours !== 12) hours += 12;
          if (period === 'AM' && hours === 12) hours = 0;
          remindAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes);
        } else if (matchBare) {
          let hours = parseInt(matchBare[1]);
          const period = matchBare[2].toUpperCase();
          if (period === 'PM' && hours !== 12) hours += 12;
          if (period === 'AM' && hours === 12) hours = 0;
          remindAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, 0);
        } else if (match24) {
          const hours = parseInt(match24[1]);
          const minutes = parseInt(match24[2]);
          remindAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes);
        } else {
          throw new Error(`Could not parse time: "${timeStr}". Use format like "3:00 PM", "4pm", or "15:00".`);
        }

        if (remindAt.getTime() <= now.getTime()) {
          remindAt.setDate(remindAt.getDate() + 1);
        }
      } else {
        remindAt = new Date(Date.now() + 30 * 60_000);
      }

      // Duplicate detection: check existing reminders for similar text + time within +/-30 min
      const baseUrl = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
      try {
        const existingRes = await fetch(`${baseUrl}/api/reminders`, { method: 'GET' });
        if (existingRes.ok) {
          const existing = await existingRes.json();
          const textLower = text.toLowerCase();
          const duplicate = existing.find((r: { text: string; remind_at: string }) => {
            const rTime = new Date(r.remind_at).getTime();
            const timeDiff = Math.abs(rTime - remindAt.getTime());
            const textSimilar = r.text.toLowerCase().includes(textLower) || textLower.includes(r.text.toLowerCase());
            return textSimilar && timeDiff < 30 * 60_000;
          });
          if (duplicate) {
            const existingTime = new Date(duplicate.remind_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Denver' });
            return this.success(toolCall, {
              success: false,
              message: `A similar reminder already exists: "${duplicate.text}" at ${existingTime}. No duplicate created.`,
            });
          }
        }
      } catch { /* continue if dedup check fails */ }

      const reminderId = `reminder_web_${Date.now()}`;
      const remindAtISO = remindAt.toISOString();

      const reminderRes = await fetch(`${baseUrl}/api/reminders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: reminderId, text, remind_at: remindAtISO }),
      });

      if (!reminderRes.ok) {
        const errText = await reminderRes.text();
        throw new Error(`Failed to save reminder: ${errText}`);
      }

      const minutesUntil = Math.round((remindAt.getTime() - Date.now()) / 60_000);
      const timeFormatted = remindAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Denver' });

      console.log(`   Reminder set: "${text}" at ${timeFormatted} (${minutesUntil}min from now)`);

      return this.success(toolCall, {
        success: true,
        message: `Reminder set for ${timeFormatted} (~${minutesUntil} minutes from now). You'll get a Signal message: "${text}"`,
        remind_at: remindAtISO,
      });
    } catch (reminderError) {
      console.error('   Reminder creation failed:', reminderError instanceof Error ? reminderError.message : reminderError);
      return this.error(toolCall, `Failed to create reminder: ${reminderError instanceof Error ? reminderError.message : 'Unknown error'}`);
    }
  }
}
