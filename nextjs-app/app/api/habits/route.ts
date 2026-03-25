import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';

// Default categories (same as handler — seed if empty)
const DEFAULT_CATEGORIES = [
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

async function ensureCategories() {
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
}

// =============================================================================
// GET /api/habits?action=entries|stats|categories|heatmap
// =============================================================================
export async function GET(req: NextRequest) {
  try {
    await ensureCategories();
    const { searchParams } = req.nextUrl;
    const action = searchParams.get('action') || 'entries';

    if (action === 'categories') {
      const categories = await prisma.habitCategory.findMany({ orderBy: { name: 'asc' } });
      return NextResponse.json({ success: true, data: categories });
    }

    // Parse common filters
    const category = searchParams.get('category') || undefined;
    const activity = searchParams.get('activity') || undefined;
    const dateFrom = searchParams.get('date_from') || undefined;
    const dateTo = searchParams.get('date_to') || undefined;
    const limit = parseInt(searchParams.get('limit') || '100');

    const where: Record<string, unknown> = {};
    if (category) where.category = category;
    if (activity) where.activity = { contains: activity };
    if (dateFrom || dateTo) {
      const ts: Record<string, Date> = {};
      if (dateFrom) ts.gte = new Date(dateFrom);
      if (dateTo) {
        const end = new Date(dateTo);
        end.setHours(23, 59, 59, 999);
        ts.lte = end;
      }
      where.timestamp = ts;
    }

    if (action === 'entries') {
      const entries = await prisma.habitEntry.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        take: limit,
      });
      return NextResponse.json({ success: true, data: entries, count: entries.length });
    }

    if (action === 'stats') {
      const period = searchParams.get('period') || 'month';
      const now = new Date();
      let periodStart: Date;
      switch (period) {
        case 'day':
          periodStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          break;
        case 'week':
          periodStart = new Date(now);
          periodStart.setDate(periodStart.getDate() - 7);
          break;
        case 'month':
          periodStart = new Date(now);
          periodStart.setMonth(periodStart.getMonth() - 1);
          break;
        case 'year':
          periodStart = new Date(now);
          periodStart.setFullYear(periodStart.getFullYear() - 1);
          break;
        default:
          periodStart = new Date(0);
      }

      const statsWhere = { ...where, timestamp: { gte: periodStart } };
      const entries = await prisma.habitEntry.findMany({
        where: statsWhere,
        orderBy: { timestamp: 'desc' },
      });

      // Category breakdown
      const categoryBreakdown: Record<string, number> = {};
      const dailyCounts: Record<string, number> = {};
      const activityBreakdown: Record<string, number> = {};

      for (const entry of entries) {
        categoryBreakdown[entry.category] = (categoryBreakdown[entry.category] || 0) + 1;
        const dayKey = entry.timestamp.toISOString().slice(0, 10);
        dailyCounts[dayKey] = (dailyCounts[dayKey] || 0) + 1;
        const actKey = `${entry.category}:${entry.activity}`;
        activityBreakdown[actKey] = (activityBreakdown[actKey] || 0) + 1;
      }

      const topActivities = Object.entries(activityBreakdown)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 10)
        .map(([key, count]) => {
          const [cat, act] = key.split(':');
          return { category: cat, activity: act, count };
        });

      // Streak
      const uniqueDays = Array.from(new Set(entries.map(e => e.timestamp.toISOString().slice(0, 10)))).sort().reverse();
      let currentStreak = 0;
      const today = now.toISOString().slice(0, 10);
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().slice(0, 10);

      if (uniqueDays[0] === today || uniqueDays[0] === yesterdayStr) {
        let checkDate = new Date(uniqueDays[0]);
        for (const day of uniqueDays) {
          if (day === checkDate.toISOString().slice(0, 10)) {
            currentStreak++;
            checkDate.setDate(checkDate.getDate() - 1);
          } else break;
        }
      }

      const daysInPeriod = Math.max(1, Math.ceil((now.getTime() - periodStart.getTime()) / (86400000)));

      return NextResponse.json({
        success: true,
        data: {
          totalCount: entries.length,
          avgPerDay: Math.round((entries.length / daysInPeriod) * 10) / 10,
          currentStreak,
          daysInPeriod,
          categoryBreakdown,
          topActivities,
          dailyCounts,
        },
      });
    }

    if (action === 'heatmap') {
      // Return daily counts for the past year (for contribution-style heatmap)
      const yearAgo = new Date();
      yearAgo.setFullYear(yearAgo.getFullYear() - 1);
      const entries = await prisma.habitEntry.findMany({
        where: { ...where, timestamp: { gte: yearAgo } },
        select: { timestamp: true },
      });

      const heatmapData: Record<string, number> = {};
      for (const entry of entries) {
        const dayKey = entry.timestamp.toISOString().slice(0, 10);
        heatmapData[dayKey] = (heatmapData[dayKey] || 0) + 1;
      }

      return NextResponse.json({ success: true, data: heatmapData });
    }

    return NextResponse.json({ success: false, error: `Unknown action: ${action}` }, { status: 400 });
  } catch (err) {
    console.error('[HabitsAPI] Error:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

// =============================================================================
// DELETE /api/habits?id=xxx
// =============================================================================
export async function DELETE(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get('id');
    if (!id) return NextResponse.json({ success: false, error: 'id required' }, { status: 400 });

    await prisma.habitEntry.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
