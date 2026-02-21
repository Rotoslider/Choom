import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import type { ToolCall, ToolResult } from '@/lib/types';
import { getGoogleClient } from '@/lib/google-client';

const CALENDAR_TOOLS = new Set([
  'get_calendar_events',
  'create_calendar_event',
  'update_calendar_event',
  'delete_calendar_event',
]);

export default class GoogleCalendarHandler extends BaseSkillHandler {
  canHandle(toolName: string): boolean {
    return CALENDAR_TOOLS.has(toolName);
  }

  async execute(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    switch (toolCall.name) {
      case 'get_calendar_events':
        return this.getCalendarEvents(toolCall);
      case 'create_calendar_event':
        return this.createCalendarEvent(toolCall);
      case 'update_calendar_event':
        return this.updateCalendarEvent(toolCall);
      case 'delete_calendar_event':
        return this.deleteCalendarEvent(toolCall);
      default:
        return this.error(toolCall, `Unknown calendar tool: ${toolCall.name}`);
    }
  }

  private async getCalendarEvents(toolCall: ToolCall): Promise<ToolResult> {
    try {
      const daysAhead = (toolCall.arguments.days_ahead as number) || 7;
      const daysBack = toolCall.arguments.days_back as number | undefined;
      const query = toolCall.arguments.query as string | undefined;
      const googleClient = getGoogleClient();
      const events = await googleClient.getCalendarEvents(daysAhead, query, daysBack);

      const formatted = events.length === 0
        ? daysBack ? 'No events found in that time range.' : 'No upcoming events found.'
        : events.map(e => {
            const start = e.start ? new Date(e.start).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Denver' }) : 'All day';
            return `- ${e.summary} (${start})${e.location ? ` @ ${e.location}` : ''}`;
          }).join('\n');

      console.log(`   📅 Calendar: ${events.length} events found (${daysBack ? `${daysBack} days back, ` : ''}${daysAhead} days ahead)`);

      return this.success(toolCall, { success: true, events, formatted, count: events.length });
    } catch (calError) {
      console.error('   ❌ Calendar error:', calError instanceof Error ? calError.message : calError);
      return this.error(toolCall, `Calendar fetch failed: ${calError instanceof Error ? calError.message : 'Unknown error'}`);
    }
  }

  private async createCalendarEvent(toolCall: ToolCall): Promise<ToolResult> {
    try {
      const summary = toolCall.arguments.summary as string;
      const startTime = toolCall.arguments.start_time as string;
      let endTime = toolCall.arguments.end_time as string | undefined;
      const description = toolCall.arguments.description as string | undefined;
      const location = toolCall.arguments.location as string | undefined;
      const allDay = toolCall.arguments.all_day as boolean | undefined;

      // Default end time to 1 hour after start if not provided
      if (!endTime && !allDay) {
        const start = new Date(startTime);
        start.setHours(start.getHours() + 1);
        endTime = start.toISOString().replace('Z', '');
      } else if (!endTime && allDay) {
        // All-day: end is next day
        const start = new Date(startTime);
        start.setDate(start.getDate() + 1);
        endTime = start.toISOString().slice(0, 10);
      }

      const googleClient = getGoogleClient();
      const event = await googleClient.createCalendarEvent(summary, startTime, endTime!, {
        description, location, allDay,
      });

      console.log(`   📅 Created calendar event: "${summary}"`);

      return this.success(toolCall, { success: true, event, message: `Created calendar event "${summary}".` });
    } catch (err) {
      console.error('   ❌ Create calendar event error:', err instanceof Error ? err.message : err);
      return this.error(toolCall, `Failed to create calendar event: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  private async updateCalendarEvent(toolCall: ToolCall): Promise<ToolResult> {
    try {
      const eventId = toolCall.arguments.event_id as string;
      const googleClient = getGoogleClient();
      const result = await googleClient.updateCalendarEvent(eventId, {
        summary: toolCall.arguments.summary as string | undefined,
        startTime: toolCall.arguments.start_time as string | undefined,
        endTime: toolCall.arguments.end_time as string | undefined,
        description: toolCall.arguments.description as string | undefined,
        location: toolCall.arguments.location as string | undefined,
      });

      console.log(`   📅 Updated calendar event: ${eventId}`);

      return this.success(toolCall, { success: true, event: result, message: `Updated calendar event.` });
    } catch (err) {
      console.error('   ❌ Update calendar event error:', err instanceof Error ? err.message : err);
      return this.error(toolCall, `Failed to update calendar event: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  private async deleteCalendarEvent(toolCall: ToolCall): Promise<ToolResult> {
    try {
      const eventId = toolCall.arguments.event_id as string;
      const googleClient = getGoogleClient();
      await googleClient.deleteCalendarEvent(eventId);

      console.log(`   🗑️ Deleted calendar event: ${eventId}`);

      return this.success(toolCall, { success: true, message: `Deleted calendar event.` });
    } catch (err) {
      console.error('   ❌ Delete calendar event error:', err instanceof Error ? err.message : err);
      return this.error(toolCall, `Failed to delete calendar event: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }
}
