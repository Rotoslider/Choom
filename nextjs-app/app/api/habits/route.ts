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
  { name: 'alcohol', icon: '🍺', color: '#a855f7', description: 'Beer, wine, spirits, cocktails' },
];

async function ensureCategories() {
  for (const cat of DEFAULT_CATEGORIES) {
    await prisma.habitCategory.upsert({
      where: { name: cat.name },
      create: cat,
      update: {}, // Don't overwrite user edits
    });
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
      // Sync: auto-create HabitCategory rows for any category strings in entries
      // that don't have a matching row yet
      const distinctEntryCategories = await prisma.habitEntry.findMany({
        distinct: ['category'],
        select: { category: true },
      });
      const existingNames = new Set(
        (await prisma.habitCategory.findMany({ select: { name: true } })).map(c => c.name)
      );
      for (const { category: catName } of distinctEntryCategories) {
        if (!existingNames.has(catName)) {
          await prisma.habitCategory.create({
            data: { name: catName },
          });
        }
      }

      // Return categories with entry counts
      const categories = await prisma.habitCategory.findMany({ orderBy: { name: 'asc' } });
      const countResults = await prisma.habitEntry.groupBy({
        by: ['category'],
        _count: { id: true },
      });
      const countMap: Record<string, number> = {};
      for (const r of countResults) {
        countMap[r.category] = r._count.id;
      }
      const categoriesWithCounts = categories.map(c => ({
        ...c,
        entryCount: countMap[c.name] || 0,
      }));

      return NextResponse.json({ success: true, data: categoriesWithCounts });
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
// PATCH /api/habits — category operations: rename, merge, update, reassign
// =============================================================================
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const { action } = body;

    // Rename a category (updates category record + all entries)
    if (action === 'rename_category') {
      const { oldName, newName } = body;
      if (!oldName || !newName) return NextResponse.json({ success: false, error: 'oldName and newName required' }, { status: 400 });
      if (oldName === newName) return NextResponse.json({ success: true, updated: 0 });

      // Check if target name already exists (would be a merge, not rename)
      const existing = await prisma.habitCategory.findUnique({ where: { name: newName } });
      if (existing) return NextResponse.json({ success: false, error: `Category "${newName}" already exists. Use merge instead.` }, { status: 409 });

      await prisma.habitCategory.update({ where: { name: oldName }, data: { name: newName } });
      const result = await prisma.habitEntry.updateMany({ where: { category: oldName }, data: { category: newName } });
      return NextResponse.json({ success: true, updated: result.count });
    }

    // Merge: move all entries from source category into target, delete source
    if (action === 'merge_category') {
      const { sourceNames, targetName } = body;
      if (!sourceNames?.length || !targetName) return NextResponse.json({ success: false, error: 'sourceNames[] and targetName required' }, { status: 400 });

      let totalUpdated = 0;
      for (const src of sourceNames as string[]) {
        if (src === targetName) continue;
        const result = await prisma.habitEntry.updateMany({ where: { category: src }, data: { category: targetName } });
        totalUpdated += result.count;
        await prisma.habitCategory.delete({ where: { name: src } }).catch(() => {});
      }
      return NextResponse.json({ success: true, updated: totalUpdated });
    }

    // Update category metadata (icon, color, description)
    if (action === 'update_category') {
      const { name, icon, color, description } = body;
      if (!name) return NextResponse.json({ success: false, error: 'name required' }, { status: 400 });

      const data: Record<string, string | null> = {};
      if (icon !== undefined) data.icon = icon || null;
      if (color !== undefined) data.color = color || null;
      if (description !== undefined) data.description = description || null;

      await prisma.habitCategory.update({ where: { name }, data });
      return NextResponse.json({ success: true });
    }

    // Create a new category
    if (action === 'create_category') {
      const { name, icon, color, description } = body;
      if (!name) return NextResponse.json({ success: false, error: 'name required' }, { status: 400 });
      const trimmed = name.trim().toLowerCase();
      const existing = await prisma.habitCategory.findUnique({ where: { name: trimmed } });
      if (existing) return NextResponse.json({ success: false, error: `Category "${trimmed}" already exists` }, { status: 409 });

      const created = await prisma.habitCategory.create({
        data: { name: trimmed, icon: icon || null, color: color || null, description: description || null },
      });
      return NextResponse.json({ success: true, data: created });
    }

    // Merge activities: rename all entries with source activity names to target name
    if (action === 'merge_activities') {
      const { sourceActivities, targetActivity, category } = body;
      if (!sourceActivities?.length || !targetActivity) return NextResponse.json({ success: false, error: 'sourceActivities[] and targetActivity required' }, { status: 400 });

      let totalUpdated = 0;
      for (const src of sourceActivities as string[]) {
        if (src === targetActivity) continue;
        const where: Record<string, unknown> = { activity: src };
        if (category) where.category = category;
        const result = await prisma.habitEntry.updateMany({ where, data: { activity: targetActivity } });
        totalUpdated += result.count;
      }
      return NextResponse.json({ success: true, updated: totalUpdated });
    }

    // Rename an activity across all entries
    if (action === 'rename_activity') {
      const { oldActivity, newActivity, category } = body;
      if (!oldActivity || !newActivity) return NextResponse.json({ success: false, error: 'oldActivity and newActivity required' }, { status: 400 });

      const where: Record<string, unknown> = { activity: oldActivity };
      if (category) where.category = category;
      const result = await prisma.habitEntry.updateMany({ where, data: { activity: newActivity } });
      return NextResponse.json({ success: true, updated: result.count });
    }

    // List distinct activities (optionally filtered by category) with counts
    if (action === 'list_activities') {
      const { category } = body;
      const where: Record<string, unknown> = {};
      if (category) where.category = category;

      const results = await prisma.habitEntry.groupBy({
        by: ['activity', 'category'],
        where,
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
      });
      const activities = results.map(r => ({
        activity: r.activity,
        category: r.category,
        count: r._count.id,
      }));
      return NextResponse.json({ success: true, data: activities });
    }

    // Reassign a single entry to a different category
    if (action === 'reassign_entry') {
      const { entryId, newCategory } = body;
      if (!entryId || !newCategory) return NextResponse.json({ success: false, error: 'entryId and newCategory required' }, { status: 400 });

      await prisma.habitEntry.update({ where: { id: entryId }, data: { category: newCategory } });
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ success: false, error: `Unknown action: ${action}` }, { status: 400 });
  } catch (err) {
    console.error('[HabitsAPI] PATCH error:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

// =============================================================================
// DELETE /api/habits?id=xxx&type=entry|category
// =============================================================================
export async function DELETE(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get('id');
    const type = req.nextUrl.searchParams.get('type') || 'entry';
    if (!id) return NextResponse.json({ success: false, error: 'id required' }, { status: 400 });

    if (type === 'category') {
      // Delete category (entries remain with their category string)
      await prisma.habitCategory.delete({ where: { id } });
    } else {
      await prisma.habitEntry.delete({ where: { id } });
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
