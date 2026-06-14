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
        return this.createReminder(toolCall, ctx.message);
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

  private async createReminder(toolCall: ToolCall, userMessage?: string): Promise<ToolResult> {
    try {
      let text = toolCall.arguments.text as string;
      const minutesFromNow = toolCall.arguments.minutes_from_now as number | undefined;
      let timeStr = toolCall.arguments.time as string | undefined;

      // Clean up text: strip stray time abbreviations like "1.m.", "a.m.", "p.m."
      text = text.replace(/\b\d+\.m\.\s*/gi, '').replace(/\b[ap]\.m\.\s*/gi, '').trim();

      // Guardrail: a "reminder" whose text is addressed to the Choom itself
      // ("remind myself…", "note to self…") is almost always meant to be a
      // self-followup, not a Signal message to Donny — sending it as a reminder
      // just spams the user. Redirect to schedule_self_followup. Conservative:
      // only fires on explicit self-reference, never on "remind me to …".
      if (/\b(?:remind\s+myself|note\s+to\s+self|for\s+myself|follow\s*up\s+with\s+myself)\b/i.test(text)) {
        return this.error(
          toolCall,
          `This reads as a note to yourself, but create_reminder sends a Signal message to Donny. To give your future self a fresh turn instead, use schedule_self_followup(delay_minutes=…, prompt="…"). If you really did mean to ping Donny, rephrase without "myself".`
        );
      }

      // AM/PM cross-check: if the user's message explicitly says "pm" but the LLM
      // sent "AM" (or vice versa), correct it. LLMs frequently confuse AM/PM.
      if (timeStr && userMessage) {
        const userMsgLower = userMessage.toLowerCase();
        const userSaidPM = /\b\d{1,2}\s*(?:p\.?m\.?|pm)\b/i.test(userMsgLower);
        const userSaidAM = /\b\d{1,2}\s*(?:a\.?m\.?|am)\b/i.test(userMsgLower);
        const llmSaidAM = /AM$/i.test(timeStr.trim());
        const llmSaidPM = /PM$/i.test(timeStr.trim());
        if (userSaidPM && llmSaidAM && !userSaidAM) {
          console.log(`   ⚠️  AM/PM mismatch: user said PM, LLM sent "${timeStr}" — correcting to PM`);
          timeStr = timeStr.replace(/AM$/i, 'PM');
        } else if (userSaidAM && llmSaidPM && !userSaidPM) {
          console.log(`   ⚠️  AM/PM mismatch: user said AM, LLM sent "${timeStr}" — correcting to AM`);
          timeStr = timeStr.replace(/PM$/i, 'AM');
        }
      }

      let remindAt: Date;

      if (minutesFromNow) {
        remindAt = new Date(Date.now() + minutesFromNow * 60_000);
      } else if (timeStr) {
        const now = new Date();

        // Normalize: drop timezone abbreviations (MDT/MST/UTC/…) and a leading
        // "at "/"on "/"by ". Chooms frequently send a FULL datetime such as
        // "2026-06-14 09:00 AM MDT" — the old parser only accepted a bare
        // time-of-day and threw "Could not parse time", silently failing.
        let s = timeStr.trim()
          .replace(/\b(?:MDT|MST|MT|PDT|PST|PT|EDT|EST|ET|CDT|CST|CT|UTC|GMT|Z)\b/gi, '')
          .replace(/^(?:at|on|by)\s+/i, '')
          .trim();

        // Pull out an explicit calendar date if present (ISO YYYY-MM-DD or M/D[/Y]).
        // When a date is given we honor it exactly (no "bump to tomorrow").
        let yr: number | undefined, mo: number | undefined, day: number | undefined;
        const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
        const us = s.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
        if (iso) {
          yr = parseInt(iso[1]); mo = parseInt(iso[2]) - 1; day = parseInt(iso[3]);
          s = s.replace(iso[0], ' ');
        } else if (us) {
          mo = parseInt(us[1]) - 1; day = parseInt(us[2]);
          yr = us[3] ? (us[3].length === 2 ? 2000 + parseInt(us[3]) : parseInt(us[3])) : now.getFullYear();
          s = s.replace(us[0], ' ');
        }
        // Drop an ISO "T" separator ("2026-06-14T09:00" → "09:00") and collapse space.
        s = s.replace(/\bT(?=\d)/i, ' ').replace(/\s+/g, ' ').trim();

        // Parse the time-of-day from whatever remains.
        const match12 = s.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
        const match24 = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
        const matchBare = s.match(/(\d{1,2})\s*(AM|PM)/i);

        let hours: number, minutes: number;
        if (match12) {
          hours = parseInt(match12[1]); minutes = parseInt(match12[2]);
          const period = match12[3].toUpperCase();
          if (period === 'PM' && hours !== 12) hours += 12;
          if (period === 'AM' && hours === 12) hours = 0;
        } else if (matchBare) {
          hours = parseInt(matchBare[1]); minutes = 0;
          const period = matchBare[2].toUpperCase();
          if (period === 'PM' && hours !== 12) hours += 12;
          if (period === 'AM' && hours === 12) hours = 0;
        } else if (match24) {
          hours = parseInt(match24[1]); minutes = parseInt(match24[2]);
        } else {
          throw new Error(`Could not parse time: "${timeStr}". Use a time like "3:00 PM", "4pm", or "15:00" — optionally with a date like "2026-06-14 9:00 AM". For "in N minutes", pass minutes_from_now instead.`);
        }

        const hasExplicitDate = day !== undefined;
        remindAt = new Date(
          yr ?? now.getFullYear(),
          mo ?? now.getMonth(),
          day ?? now.getDate(),
          hours, minutes,
        );
        // Only roll a bare time-of-day forward to tomorrow when it's already
        // past today. An explicit date is honored as-is.
        if (!hasExplicitDate && remindAt.getTime() <= now.getTime()) {
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
