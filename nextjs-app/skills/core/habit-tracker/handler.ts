import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import type { ToolCall, ToolResult } from '@/lib/types';
import prisma from '@/lib/db';

const TOOL_NAMES = new Set([
  'log_habit',
  'query_habits',
  'habit_stats',
  'manage_categories',
  'delete_habit',
]);

// Default categories with icons and chart colors
const DEFAULT_CATEGORIES: { name: string; icon: string; color: string; description: string }[] = [
  { name: 'vehicle', icon: '🚗', color: '#3b82f6', description: 'Gas, oil change, car wash, maintenance' },
  { name: 'hygiene', icon: '🚿', color: '#06b6d4', description: 'Shower, laundry, haircut' },
  { name: 'shopping', icon: '🛒', color: '#f59e0b', description: 'Walmart, grocery, purchases' },
  { name: 'outdoor', icon: '🏕️', color: '#22c55e', description: 'Camping, hiking, fishing, parks' },
  { name: 'maintenance', icon: '🔧', color: '#8b5cf6', description: 'Water tank, dump run, repairs, cleaning' },
  { name: 'health', icon: '💪', color: '#ef4444', description: 'Doctor, medication, exercise' },
  { name: 'food', icon: '🍳', color: '#f97316', description: 'Cooking, eating out, meal prep' },
  { name: 'travel', icon: '✈️', color: '#0ea5e9', description: 'Road trips, flights, hotel stays' },
  { name: 'social', icon: '👥', color: '#ec4899', description: 'Friends, parties, events' },
  { name: 'finance', icon: '💰', color: '#14b8a6', description: 'Bills, ATM, bank visits' },
];

let categoriesSeeded = false;

async function ensureDefaultCategories(): Promise<void> {
  if (categoriesSeeded) return;
  const count = await prisma.habitCategory.count();
  if (count === 0) {
    for (const cat of DEFAULT_CATEGORIES) {
      await prisma.habitCategory.upsert({
        where: { name: cat.name },
        create: cat,
        update: {},
      });
    }
  }
  categoriesSeeded = true;
}

export default class HabitTrackerHandler extends BaseSkillHandler {
  canHandle(toolName: string): boolean {
    return TOOL_NAMES.has(toolName);
  }

  async execute(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    await ensureDefaultCategories();

    switch (toolCall.name) {
      case 'log_habit':
        return this.logHabit(toolCall, ctx);
      case 'query_habits':
        return this.queryHabits(toolCall);
      case 'habit_stats':
        return this.habitStats(toolCall);
      case 'manage_categories':
        return this.manageCategories(toolCall);
      case 'delete_habit':
        return this.deleteHabit(toolCall);
      default:
        return this.error(toolCall, `Unknown habit tool: ${toolCall.name}`);
    }
  }

  // ===========================================================================
  // log_habit
  // ===========================================================================
  private async logHabit(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    try {
      const args = toolCall.arguments;
      const category = (args.category as string || '').toLowerCase().trim();
      const activity = args.activity as string;
      const location = args.location as string | undefined;
      const notes = args.notes as string | undefined;
      const quantity = args.quantity as number | undefined;
      const unit = args.unit as string | undefined;
      const timestampStr = args.timestamp as string | undefined;

      if (!category || !activity) {
        return this.error(toolCall, 'Both category and activity are required');
      }

      const timestamp = timestampStr ? new Date(timestampStr) : new Date();
      if (isNaN(timestamp.getTime())) {
        return this.error(toolCall, `Invalid timestamp: "${timestampStr}"`);
      }

      const entry = await prisma.habitEntry.create({
        data: {
          choomId: ctx.choomId,
          category,
          activity,
          location: location || null,
          notes: notes || null,
          quantity: quantity ?? null,
          unit: unit || null,
          timestamp,
        },
      });

      const timeStr = timestamp.toLocaleString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZone: 'America/Denver',
      });

      const quantityStr = quantity && unit ? ` (${quantity} ${unit})` : '';
      const locationStr = location ? ` at ${location}` : '';

      console.log(`   📋 Habit logged: [${category}] ${activity}${locationStr}${quantityStr} — ${timeStr}`);

      return this.success(toolCall, {
        success: true,
        entry_id: entry.id,
        message: `Logged: ${activity}${locationStr}${quantityStr} [${category}] — ${timeStr}`,
      });
    } catch (err) {
      console.error('   Habit log failed:', err instanceof Error ? err.message : err);
      return this.error(toolCall, `Failed to log habit: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  // ===========================================================================
  // query_habits
  // ===========================================================================
  private async queryHabits(toolCall: ToolCall): Promise<ToolResult> {
    try {
      const args = toolCall.arguments;
      const category = args.category as string | undefined;
      const activity = args.activity as string | undefined;
      const location = args.location as string | undefined;
      const dateFrom = args.date_from as string | undefined;
      const dateTo = args.date_to as string | undefined;
      const limit = (args.limit as number) || 20;
      const order = (args.order as string) || 'newest';

      // Build Prisma where clause
      const where: Record<string, unknown> = {};
      if (category) where.category = category.toLowerCase().trim();
      if (activity) where.activity = { contains: activity };
      if (location) where.location = { contains: location };
      if (dateFrom || dateTo) {
        const ts: Record<string, Date> = {};
        if (dateFrom) ts.gte = new Date(dateFrom);
        if (dateTo) {
          // Include the entire end date
          const end = new Date(dateTo);
          end.setHours(23, 59, 59, 999);
          ts.lte = end;
        }
        where.timestamp = ts;
      }

      const entries = await prisma.habitEntry.findMany({
        where,
        orderBy: { timestamp: order === 'oldest' ? 'asc' : 'desc' },
        take: limit,
      });

      const formatted = entries.length === 0
        ? 'No matching habit entries found.'
        : entries.map((e) => {
            const time = e.timestamp.toLocaleString('en-US', {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
              timeZone: 'America/Denver',
            });
            const qty = e.quantity && e.unit ? ` (${e.quantity} ${e.unit})` : '';
            const loc = e.location ? ` at ${e.location}` : '';
            return `- [${e.category}] ${e.activity}${loc}${qty} — ${time} (id: ${e.id})`;
          }).join('\n');

      return this.success(toolCall, {
        success: true,
        count: entries.length,
        entries,
        formatted,
      });
    } catch (err) {
      return this.error(toolCall, `Query failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  // ===========================================================================
  // habit_stats
  // ===========================================================================
  private async habitStats(toolCall: ToolCall): Promise<ToolResult> {
    try {
      const args = toolCall.arguments;
      const period = (args.period as string) || 'week';
      const category = args.category as string | undefined;
      const activity = args.activity as string | undefined;

      // Calculate date range
      const now = new Date();
      let dateFrom: Date;
      switch (period) {
        case 'day':
          dateFrom = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          break;
        case 'week':
          dateFrom = new Date(now);
          dateFrom.setDate(dateFrom.getDate() - 7);
          break;
        case 'month':
          dateFrom = new Date(now);
          dateFrom.setMonth(dateFrom.getMonth() - 1);
          break;
        case 'year':
          dateFrom = new Date(now);
          dateFrom.setFullYear(dateFrom.getFullYear() - 1);
          break;
        case 'all':
        default:
          dateFrom = new Date(0);
          break;
      }

      // Build where clause
      const where: Record<string, unknown> = {
        timestamp: { gte: dateFrom },
      };
      if (category) where.category = category.toLowerCase().trim();
      if (activity) where.activity = { contains: activity };

      // Total count
      const totalCount = await prisma.habitEntry.count({ where });

      // Get all entries for breakdown
      const entries = await prisma.habitEntry.findMany({
        where,
        orderBy: { timestamp: 'desc' },
      });

      // Category breakdown
      const categoryBreakdown: Record<string, number> = {};
      const activityBreakdown: Record<string, number> = {};
      const dailyCounts: Record<string, number> = {};

      for (const entry of entries) {
        // Category counts
        categoryBreakdown[entry.category] = (categoryBreakdown[entry.category] || 0) + 1;

        // Activity counts
        const actKey = `${entry.category}:${entry.activity}`;
        activityBreakdown[actKey] = (activityBreakdown[actKey] || 0) + 1;

        // Daily counts for trend
        const dayKey = entry.timestamp.toISOString().slice(0, 10);
        dailyCounts[dayKey] = (dailyCounts[dayKey] || 0) + 1;
      }

      // Top activities
      const topActivities = Object.entries(activityBreakdown)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 10)
        .map(([key, count]) => {
          const [cat, act] = key.split(':');
          return { category: cat, activity: act, count };
        });

      // Streak calculation (consecutive days with at least one entry)
      const uniqueDays = Array.from(new Set(entries.map(e => e.timestamp.toISOString().slice(0, 10)))).sort().reverse();
      let currentStreak = 0;
      const today = now.toISOString().slice(0, 10);
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().slice(0, 10);

      // Start counting from today or yesterday
      if (uniqueDays[0] === today || uniqueDays[0] === yesterdayStr) {
        let checkDate = new Date(uniqueDays[0]);
        for (const day of uniqueDays) {
          const expected = checkDate.toISOString().slice(0, 10);
          if (day === expected) {
            currentStreak++;
            checkDate.setDate(checkDate.getDate() - 1);
          } else {
            break;
          }
        }
      }

      // Days in period for average
      const daysInPeriod = Math.max(1, Math.ceil((now.getTime() - dateFrom.getTime()) / (1000 * 60 * 60 * 24)));
      const avgPerDay = totalCount / daysInPeriod;

      // Format summary
      const periodLabel = period === 'all' ? 'all time' : `past ${period}`;
      const lines = [
        `📊 Habit Stats (${periodLabel}):`,
        `Total entries: ${totalCount} | Avg/day: ${avgPerDay.toFixed(1)} | Current streak: ${currentStreak} day${currentStreak !== 1 ? 's' : ''}`,
        '',
        '**By Category:**',
        ...Object.entries(categoryBreakdown)
          .sort(([, a], [, b]) => b - a)
          .map(([cat, count]) => `  ${cat}: ${count}`),
        '',
        '**Top Activities:**',
        ...topActivities.map((a, i) => `  ${i + 1}. ${a.activity} (${a.category}): ${a.count}x`),
      ];

      return this.success(toolCall, {
        success: true,
        period,
        totalCount,
        avgPerDay: Math.round(avgPerDay * 10) / 10,
        currentStreak,
        daysInPeriod,
        categoryBreakdown,
        topActivities,
        dailyCounts,
        formatted: lines.join('\n'),
      });
    } catch (err) {
      return this.error(toolCall, `Stats failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  // ===========================================================================
  // manage_categories
  // ===========================================================================
  private async manageCategories(toolCall: ToolCall): Promise<ToolResult> {
    try {
      const args = toolCall.arguments;
      const action = (args.action as string) || 'list';

      if (action === 'list') {
        const categories = await prisma.habitCategory.findMany({
          orderBy: { name: 'asc' },
        });
        const formatted = categories
          .map((c) => `${c.icon || '•'} **${c.name}** ${c.color || ''} — ${c.description || ''}`)
          .join('\n');
        return this.success(toolCall, { success: true, categories, formatted });
      }

      if (action === 'add' || action === 'update') {
        const name = (args.name as string || '').toLowerCase().trim();
        if (!name) return this.error(toolCall, 'Category name is required');

        const data: Record<string, string | undefined> = {};
        if (args.icon) data.icon = args.icon as string;
        if (args.color) data.color = args.color as string;
        if (args.description) data.description = args.description as string;

        const category = await prisma.habitCategory.upsert({
          where: { name },
          create: { name, ...data },
          update: data,
        });

        return this.success(toolCall, {
          success: true,
          message: `Category "${name}" ${action === 'add' ? 'created' : 'updated'}`,
          category,
        });
      }

      return this.error(toolCall, `Unknown action: ${action}. Use "list", "add", or "update".`);
    } catch (err) {
      return this.error(toolCall, `Category operation failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  // ===========================================================================
  // delete_habit
  // ===========================================================================
  private async deleteHabit(toolCall: ToolCall): Promise<ToolResult> {
    try {
      const entryId = toolCall.arguments.entry_id as string;
      if (!entryId) return this.error(toolCall, 'entry_id is required');

      const existing = await prisma.habitEntry.findUnique({ where: { id: entryId } });
      if (!existing) return this.error(toolCall, `No habit entry found with ID: ${entryId}`);

      await prisma.habitEntry.delete({ where: { id: entryId } });

      console.log(`   🗑️ Habit deleted: [${existing.category}] ${existing.activity} (${entryId})`);

      return this.success(toolCall, {
        success: true,
        message: `Deleted habit entry: [${existing.category}] ${existing.activity}`,
      });
    } catch (err) {
      return this.error(toolCall, `Delete failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }
}
