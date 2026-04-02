'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Activity,
  RefreshCw,
  Loader2,
  Trash2,
  Flame,
  TrendingUp,
  Calendar,
  BarChart3,
  Settings2,
  Pencil,
  Merge,
  Check,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  CartesianGrid,
  PieChart,
  Pie,
  Cell,
} from 'recharts';

// =============================================================================
// Types
// =============================================================================

interface HabitEntry {
  id: string;
  choomId: string;
  category: string;
  activity: string;
  location: string | null;
  notes: string | null;
  quantity: number | null;
  unit: string | null;
  timestamp: string;
  createdAt: string;
}

interface HabitCategory {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
  description: string | null;
  entryCount?: number;
}

interface HabitStats {
  totalCount: number;
  avgPerDay: number;
  currentStreak: number;
  daysInPeriod: number;
  categoryBreakdown: Record<string, number>;
  topActivities: { category: string; activity: string; count: number }[];
  dailyCounts: Record<string, number>;
}

type Period = 'day' | 'week' | 'month' | 'year' | 'all';

const PERIOD_OPTIONS: { id: Period; label: string }[] = [
  { id: 'day', label: 'Today' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'year', label: 'Year' },
  { id: 'all', label: 'All Time' },
];

// Fallback colors for categories without a db color
const FALLBACK_COLORS = [
  '#3b82f6', '#06b6d4', '#f59e0b', '#22c55e', '#8b5cf6',
  '#ef4444', '#f97316', '#0ea5e9', '#ec4899', '#14b8a6',
];

// =============================================================================
// Heatmap Component (GitHub-style contribution grid)
// =============================================================================

function HabitHeatmap({ data }: { data: Record<string, number> }) {
  const today = new Date();
  const weeks: { date: string; count: number; dayOfWeek: number }[][] = [];

  // Build 52 weeks of data
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - 363); // ~52 weeks back
  // Align to Sunday
  startDate.setDate(startDate.getDate() - startDate.getDay());

  let currentWeek: { date: string; count: number; dayOfWeek: number }[] = [];
  const cursor = new Date(startDate);

  while (cursor <= today) {
    const dateStr = cursor.toISOString().slice(0, 10);
    currentWeek.push({
      date: dateStr,
      count: data[dateStr] || 0,
      dayOfWeek: cursor.getDay(),
    });
    if (cursor.getDay() === 6) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  if (currentWeek.length > 0) weeks.push(currentWeek);

  const maxCount = Math.max(1, ...Object.values(data));

  function getColor(count: number): string {
    if (count === 0) return 'var(--muted)';
    const intensity = Math.min(count / maxCount, 1);
    if (intensity < 0.25) return '#9be9a8';
    if (intensity < 0.5) return '#40c463';
    if (intensity < 0.75) return '#30a14e';
    return '#216e39';
  }

  // Month labels
  const monthLabels: { label: string; weekIndex: number }[] = [];
  let lastMonth = -1;
  weeks.forEach((week, i) => {
    const firstDay = week[0];
    if (firstDay) {
      const month = new Date(firstDay.date).getMonth();
      if (month !== lastMonth) {
        monthLabels.push({
          label: new Date(firstDay.date).toLocaleString('en-US', { month: 'short' }),
          weekIndex: i,
        });
        lastMonth = month;
      }
    }
  });

  return (
    <div className="overflow-x-auto">
      {/* Month labels */}
      <div className="flex ml-8 mb-1 text-[10px] text-muted-foreground">
        {monthLabels.map((m, i) => (
          <span
            key={i}
            style={{ marginLeft: i === 0 ? m.weekIndex * 13 : (m.weekIndex - (monthLabels[i - 1]?.weekIndex || 0)) * 13 - 20 }}
          >
            {m.label}
          </span>
        ))}
      </div>
      <div className="flex gap-[1px]">
        {/* Day labels */}
        <div className="flex flex-col gap-[1px] text-[10px] text-muted-foreground mr-1 pt-0">
          {['', 'Mon', '', 'Wed', '', 'Fri', ''].map((d, i) => (
            <div key={i} className="h-[11px] leading-[11px]">{d}</div>
          ))}
        </div>
        {/* Grid */}
        {weeks.map((week, wi) => (
          <div key={wi} className="flex flex-col gap-[1px]">
            {Array.from({ length: 7 }).map((_, di) => {
              const day = week.find(d => d.dayOfWeek === di);
              if (!day) return <div key={di} className="w-[11px] h-[11px]" />;
              return (
                <div
                  key={di}
                  className="w-[11px] h-[11px] rounded-[2px] cursor-default"
                  style={{ backgroundColor: getColor(day.count) }}
                  title={`${day.date}: ${day.count} ${day.count === 1 ? 'entry' : 'entries'}`}
                />
              );
            })}
          </div>
        ))}
      </div>
      {/* Legend */}
      <div className="flex items-center gap-1 mt-2 text-[10px] text-muted-foreground ml-8">
        <span>Less</span>
        {[0, 0.25, 0.5, 0.75, 1].map((v) => (
          <div
            key={v}
            className="w-[11px] h-[11px] rounded-[2px]"
            style={{ backgroundColor: getColor(v * maxCount) }}
          />
        ))}
        <span>More</span>
      </div>
    </div>
  );
}

// =============================================================================
// Main Page
// =============================================================================

export default function HabitsPage() {
  const router = useRouter();
  const [entries, setEntries] = useState<HabitEntry[]>([]);
  const [categories, setCategories] = useState<HabitCategory[]>([]);
  const [stats, setStats] = useState<HabitStats | null>(null);
  const [heatmapData, setHeatmapData] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<Period>('month');
  const [filterCategory, setFilterCategory] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [showCategoryManager, setShowCategoryManager] = useState(false);
  const [renamingCategory, setRenamingCategory] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [mergeSelections, setMergeSelections] = useState<Set<string>>(new Set());
  const [mergeTarget, setMergeTarget] = useState<string>('');
  const [categoryActionLoading, setCategoryActionLoading] = useState(false);
  const [activities, setActivities] = useState<{ activity: string; category: string; count: number }[]>([]);
  const [activityMergeSelections, setActivityMergeSelections] = useState<Set<string>>(new Set());
  const [activityMergeTarget, setActivityMergeTarget] = useState('');
  const [activityFilterCategory, setActivityFilterCategory] = useState('');
  const [renamingActivity, setRenamingActivity] = useState<string | null>(null);
  const [activityRenameValue, setActivityRenameValue] = useState('');
  const [newCategoryName, setNewCategoryName] = useState('');
  const [newCategoryIcon, setNewCategoryIcon] = useState('');
  const [newCategoryColor, setNewCategoryColor] = useState('#888888');

  const categoryColorMap = useCallback((): Record<string, string> => {
    const map: Record<string, string> = {};
    categories.forEach((c, i) => {
      map[c.name] = c.color || FALLBACK_COLORS[i % FALLBACK_COLORS.length];
    });
    return map;
  }, [categories]);

  const categoryIconMap = useCallback((): Record<string, string> => {
    const map: Record<string, string> = {};
    categories.forEach((c) => {
      if (c.icon) map[c.name] = c.icon;
    });
    return map;
  }, [categories]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const catParam = filterCategory ? `&category=${encodeURIComponent(filterCategory)}` : '';
      const [entriesRes, categoriesRes, statsRes, heatmapRes] = await Promise.all([
        fetch(`/api/habits?action=entries&limit=50${catParam}`),
        fetch('/api/habits?action=categories'),
        fetch(`/api/habits?action=stats&period=${period}${catParam}`),
        fetch(`/api/habits?action=heatmap${catParam}`),
      ]);

      if (entriesRes.ok) {
        const d = await entriesRes.json();
        setEntries(d.data || []);
      }
      if (categoriesRes.ok) {
        const d = await categoriesRes.json();
        setCategories(d.data || []);
      }
      if (statsRes.ok) {
        const d = await statsRes.json();
        setStats(d.data || null);
      }
      if (heatmapRes.ok) {
        const d = await heatmapRes.json();
        setHeatmapData(d.data || {});
      }
      // Fetch activities for the manager
      const actRes = await fetch('/api/habits', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list_activities' }),
      });
      if (actRes.ok) {
        const d = await actRes.json();
        setActivities(d.data || []);
      }
    } catch {
      setError('Failed to load habit data');
    } finally {
      setLoading(false);
    }
  }, [period, filterCategory]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/habits?id=${id}`, { method: 'DELETE' });
      if (res.ok) {
        setEntries((prev) => prev.filter((e) => e.id !== id));
        fetchAll(); // Refresh stats
      }
    } catch { /* ignore */ }
  };

  const handleRenameCategory = async (oldName: string) => {
    const newName = renameValue.trim().toLowerCase();
    if (!newName || newName === oldName) { setRenamingCategory(null); return; }
    setCategoryActionLoading(true);
    try {
      const res = await fetch('/api/habits', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rename_category', oldName, newName }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Rename failed');
      } else {
        setRenamingCategory(null);
        fetchAll();
      }
    } catch { alert('Rename failed'); }
    finally { setCategoryActionLoading(false); }
  };

  const handleMergeCategories = async () => {
    if (mergeSelections.size < 2 || !mergeTarget) return;
    const sourceNames = Array.from(mergeSelections).filter(n => n !== mergeTarget);
    if (sourceNames.length === 0) return;
    setCategoryActionLoading(true);
    try {
      const res = await fetch('/api/habits', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'merge_category', sourceNames, targetName: mergeTarget }),
      });
      if (res.ok) {
        setMergeSelections(new Set());
        setMergeTarget('');
        fetchAll();
      }
    } catch { alert('Merge failed'); }
    finally { setCategoryActionLoading(false); }
  };

  const handleDeleteCategory = async (id: string) => {
    setCategoryActionLoading(true);
    try {
      const res = await fetch(`/api/habits?id=${id}&type=category`, { method: 'DELETE' });
      if (res.ok) fetchAll();
    } catch { /* ignore */ }
    finally { setCategoryActionLoading(false); }
  };

  const handleCreateCategory = async () => {
    const name = newCategoryName.trim().toLowerCase();
    if (!name) return;
    setCategoryActionLoading(true);
    try {
      const res = await fetch('/api/habits', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create_category',
          name,
          icon: newCategoryIcon || null,
          color: newCategoryColor || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Create failed');
      } else {
        setNewCategoryName('');
        setNewCategoryIcon('');
        setNewCategoryColor('#888888');
        fetchAll();
      }
    } catch { alert('Create failed'); }
    finally { setCategoryActionLoading(false); }
  };

  const toggleMergeSelection = (name: string) => {
    setMergeSelections(prev => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
        if (mergeTarget === name) setMergeTarget('');
      } else {
        next.add(name);
        if (!mergeTarget) setMergeTarget(name);
      }
      return next;
    });
  };

  const handleMergeActivities = async () => {
    if (activityMergeSelections.size < 2 || !activityMergeTarget) return;
    const sourceActivities = Array.from(activityMergeSelections).filter(a => a !== activityMergeTarget);
    if (sourceActivities.length === 0) return;
    setCategoryActionLoading(true);
    try {
      const res = await fetch('/api/habits', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'merge_activities',
          sourceActivities,
          targetActivity: activityMergeTarget,
          category: activityFilterCategory || undefined,
        }),
      });
      if (res.ok) {
        setActivityMergeSelections(new Set());
        setActivityMergeTarget('');
        fetchAll();
      }
    } catch { alert('Merge failed'); }
    finally { setCategoryActionLoading(false); }
  };

  const handleRenameActivity = async (oldActivity: string) => {
    const newActivity = activityRenameValue.trim().toLowerCase();
    if (!newActivity || newActivity === oldActivity) { setRenamingActivity(null); return; }
    setCategoryActionLoading(true);
    try {
      const res = await fetch('/api/habits', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rename_activity', oldActivity, newActivity }),
      });
      if (res.ok) {
        setRenamingActivity(null);
        fetchAll();
      }
    } catch { alert('Rename failed'); }
    finally { setCategoryActionLoading(false); }
  };

  const toggleActivityMergeSelection = (activity: string) => {
    setActivityMergeSelections(prev => {
      const next = new Set(prev);
      if (next.has(activity)) {
        next.delete(activity);
        if (activityMergeTarget === activity) setActivityMergeTarget('');
      } else {
        next.add(activity);
        if (!activityMergeTarget) setActivityMergeTarget(activity);
      }
      return next;
    });
  };

  // Filtered activities for the manager
  const filteredActivities = activityFilterCategory
    ? activities.filter(a => a.category === activityFilterCategory)
    : activities;

  // Chart data transforms
  const colors = categoryColorMap();
  const icons = categoryIconMap();

  // Category pie chart data
  const pieData = stats
    ? Object.entries(stats.categoryBreakdown).map(([name, value]) => ({
        name,
        value,
        color: colors[name] || '#888',
      }))
    : [];

  // Daily trend line chart data
  const dailyData = stats
    ? Object.entries(stats.dailyCounts)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, count]) => ({
          date: date.slice(5), // MM-DD
          count,
        }))
    : [];

  // Top activities bar chart data
  const topBarData = stats
    ? stats.topActivities.slice(0, 8).map((a) => ({
        name: a.activity.length > 15 ? a.activity.slice(0, 15) + '...' : a.activity,
        count: a.count,
        color: colors[a.category] || '#888',
      }))
    : [];

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="border-b border-border bg-card px-6 py-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={() => router.push('/')} className="-ml-2">
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div>
              <h1 className="text-lg font-semibold flex items-center gap-2">
                <Activity className="h-5 w-5" />
                Habit Tracker
              </h1>
              <p className="text-xs text-muted-foreground mt-0.5">
                {stats ? (
                  <>
                    {stats.totalCount} entries | {stats.avgPerDay}/day avg |{' '}
                    <Flame className="inline h-3 w-3 text-orange-500" /> {stats.currentStreak} day streak
                  </>
                ) : (
                  'Loading...'
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowCategoryManager(!showCategoryManager)}
              className={cn(showCategoryManager && 'bg-primary/15 text-primary')}
            >
              <Settings2 className="h-4 w-4 mr-1" />
              Categories
            </Button>
            <Button variant="outline" size="sm" onClick={fetchAll}>
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-3 flex-wrap">
          {/* Period selector */}
          <div className="flex items-center gap-1 rounded-lg border border-border p-0.5">
            {PERIOD_OPTIONS.map((p) => (
              <button
                key={p.id}
                onClick={() => setPeriod(p.id)}
                className={cn(
                  'px-2.5 py-1 text-xs font-medium rounded-md transition-colors',
                  period === p.id
                    ? 'bg-primary/15 text-primary'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                )}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Category filter */}
          <select
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
            className="h-8 text-xs rounded-md bg-muted border border-border px-2 min-w-[140px]"
          >
            <option value="">All Categories</option>
            {categories.map((c) => (
              <option key={c.id} value={c.name}>
                {c.icon || ''} {c.name}
              </option>
            ))}
          </select>
        </div>
      </header>

      {/* Content */}
      <ScrollArea className="flex-1">
        <div className="p-6 space-y-6">
          {error ? (
            <div className="text-center py-16 text-muted-foreground">
              <p className="text-sm">{error}</p>
              <Button variant="outline" size="sm" className="mt-4" onClick={fetchAll}>
                Retry
              </Button>
            </div>
          ) : loading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin mr-2" />
              Loading habits...
            </div>
          ) : (
            <>
              {/* Stat cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <StatCard
                  icon={<BarChart3 className="h-4 w-4" />}
                  label="Total Entries"
                  value={stats?.totalCount ?? 0}
                />
                <StatCard
                  icon={<TrendingUp className="h-4 w-4" />}
                  label="Avg / Day"
                  value={stats?.avgPerDay ?? 0}
                />
                <StatCard
                  icon={<Flame className="h-4 w-4 text-orange-500" />}
                  label="Day Streak"
                  value={stats?.currentStreak ?? 0}
                />
                <StatCard
                  icon={<Calendar className="h-4 w-4" />}
                  label="Active Days"
                  value={stats ? Object.keys(stats.dailyCounts).length : 0}
                />
              </div>

              {/* Heatmap */}
              <div className="bg-card border border-border rounded-lg p-4">
                <h3 className="text-sm font-medium mb-3">Activity Heatmap (Past Year)</h3>
                <HabitHeatmap data={heatmapData} />
              </div>

              {/* Charts row */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                {/* Daily trend */}
                <div className="bg-card border border-border rounded-lg p-4 lg:col-span-2">
                  <h3 className="text-sm font-medium mb-3">Daily Activity</h3>
                  {dailyData.length > 0 ? (
                    <ResponsiveContainer width="100%" height={200}>
                      <LineChart data={dailyData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--border))" />
                        <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'rgb(var(--muted-foreground))' }} stroke="rgb(var(--border))" />
                        <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: 'rgb(var(--muted-foreground))' }} stroke="rgb(var(--border))" />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: 'rgb(var(--card))',
                            border: '1px solid rgb(var(--border))',
                            borderRadius: 8,
                            fontSize: 12,
                            color: 'rgb(var(--foreground))',
                          }}
                          labelStyle={{ color: 'rgb(var(--muted-foreground))' }}
                          itemStyle={{ color: 'rgb(var(--foreground))' }}
                        />
                        <Line
                          type="monotone"
                          dataKey="count"
                          stroke="#3b82f6"
                          strokeWidth={2}
                          dot={{ r: 3 }}
                          activeDot={{ r: 5 }}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  ) : (
                    <p className="text-xs text-muted-foreground text-center py-8">No data for this period</p>
                  )}
                </div>

                {/* Category breakdown pie */}
                <div className="bg-card border border-border rounded-lg p-4">
                  <h3 className="text-sm font-medium mb-3">By Category</h3>
                  {pieData.length > 0 ? (
                    <ResponsiveContainer width="100%" height={260}>
                      <PieChart>
                        <Pie
                          data={pieData}
                          cx="50%"
                          cy="50%"
                          innerRadius={35}
                          outerRadius={70}
                          dataKey="value"
                          nameKey="name"
                          label={(props: any) => {
                            const { name, value, cx, cy, midAngle, outerRadius: oR } = props;
                            const RADIAN = Math.PI / 180;
                            const radius = (oR as number) + 20;
                            const ma = (midAngle as number) || 0;
                            const x = (cx as number) + radius * Math.cos(-ma * RADIAN);
                            const y = (cy as number) + radius * Math.sin(-ma * RADIAN);
                            return (
                              <text
                                x={x}
                                y={y}
                                fill="rgb(var(--foreground))"
                                textAnchor={x > (cx as number) ? 'start' : 'end'}
                                dominantBaseline="central"
                                fontSize={11}
                              >
                                {`${name} (${value})`}
                              </text>
                            );
                          }}
                          labelLine={{ stroke: 'rgb(var(--muted-foreground))', strokeWidth: 1 }}
                        >
                          {pieData.map((entry, i) => (
                            <Cell key={i} fill={entry.color} />
                          ))}
                        </Pie>
                        <Tooltip
                          contentStyle={{
                            backgroundColor: 'rgb(var(--card))',
                            border: '1px solid rgb(var(--border))',
                            borderRadius: 8,
                            fontSize: 12,
                            color: 'rgb(var(--foreground))',
                          }}
                          itemStyle={{ color: 'rgb(var(--foreground))' }}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  ) : (
                    <p className="text-xs text-muted-foreground text-center py-8">No data</p>
                  )}
                </div>
              </div>

              {/* Top activities bar chart */}
              {topBarData.length > 0 && (
                <div className="bg-card border border-border rounded-lg p-4">
                  <h3 className="text-sm font-medium mb-3">Top Activities</h3>
                  <ResponsiveContainer width="100%" height={Math.max(150, topBarData.length * 32)}>
                    <BarChart data={topBarData} layout="vertical" margin={{ left: 80 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--border))" />
                      <XAxis type="number" allowDecimals={false} tick={{ fontSize: 10, fill: 'rgb(var(--muted-foreground))' }} stroke="rgb(var(--border))" />
                      <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: 'rgb(var(--foreground))' }} stroke="rgb(var(--border))" width={80} />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: 'rgb(var(--card))',
                          border: '1px solid rgb(var(--border))',
                          borderRadius: 8,
                          fontSize: 12,
                          color: 'rgb(var(--foreground))',
                        }}
                        labelStyle={{ color: 'rgb(var(--muted-foreground))' }}
                        itemStyle={{ color: 'rgb(var(--foreground))' }}
                      />
                      <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                        {topBarData.map((entry, i) => (
                          <Cell key={i} fill={entry.color} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}

              {/* Category Manager */}
              {showCategoryManager && (
                <div className="bg-card border border-border rounded-lg">
                  <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                    <h3 className="text-sm font-medium">Manage Categories</h3>
                    {mergeSelections.size >= 2 && (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                          Merge {mergeSelections.size} into:
                        </span>
                        <select
                          value={mergeTarget}
                          onChange={(e) => setMergeTarget(e.target.value)}
                          className="h-7 text-xs rounded-md bg-muted border border-border px-2"
                        >
                          {Array.from(mergeSelections).map(name => (
                            <option key={name} value={name}>{name}</option>
                          ))}
                        </select>
                        <Button
                          variant="default"
                          size="sm"
                          className="h-7 text-xs"
                          disabled={categoryActionLoading}
                          onClick={handleMergeCategories}
                        >
                          <Merge className="h-3 w-3 mr-1" />
                          Merge
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => { setMergeSelections(new Set()); setMergeTarget(''); }}
                        >
                          Cancel
                        </Button>
                      </div>
                    )}
                  </div>
                  <div className="divide-y divide-border">
                    {categories.map((cat) => {
                      const entryCount = cat.entryCount || 0;
                      const isRenaming = renamingCategory === cat.name;
                      const isSelected = mergeSelections.has(cat.name);
                      return (
                        <div
                          key={cat.id}
                          className={cn(
                            'flex items-center gap-3 px-4 py-2.5 transition-colors',
                            isSelected && 'bg-primary/5'
                          )}
                        >
                          {/* Merge checkbox */}
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleMergeSelection(cat.name)}
                            className="h-3.5 w-3.5 rounded border-border accent-primary flex-shrink-0"
                          />
                          {/* Color dot */}
                          <div
                            className="w-3 h-3 rounded-full flex-shrink-0"
                            style={{ backgroundColor: cat.color || '#888' }}
                          />
                          {/* Icon */}
                          <span className="text-base w-6 text-center flex-shrink-0">{cat.icon || '•'}</span>
                          {/* Name / rename input */}
                          {isRenaming ? (
                            <div className="flex items-center gap-1.5 flex-1">
                              <input
                                type="text"
                                value={renameValue}
                                onChange={(e) => setRenameValue(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') handleRenameCategory(cat.name);
                                  if (e.key === 'Escape') setRenamingCategory(null);
                                }}
                                className="h-7 text-sm rounded-md bg-muted border border-border px-2 flex-1"
                                autoFocus
                              />
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0"
                                disabled={categoryActionLoading}
                                onClick={() => handleRenameCategory(cat.name)}
                              >
                                <Check className="h-3.5 w-3.5 text-green-500" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0"
                                onClick={() => setRenamingCategory(null)}
                              >
                                <X className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          ) : (
                            <div className="flex-1 min-w-0">
                              <span className="text-sm font-medium">{cat.name}</span>
                              {cat.description && (
                                <span className="text-xs text-muted-foreground ml-2">{cat.description}</span>
                              )}
                            </div>
                          )}
                          {/* Entry count */}
                          <span className="text-xs text-muted-foreground tabular-nums flex-shrink-0">
                            {entryCount} {entryCount === 1 ? 'entry' : 'entries'}
                          </span>
                          {/* Actions */}
                          {!isRenaming && (
                            <div className="flex items-center gap-0.5">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                                onClick={() => { setRenamingCategory(cat.name); setRenameValue(cat.name); }}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                                onClick={() => {
                                  if (confirm(`Delete category "${cat.name}"? Entries will keep their category label but it won't appear in filters.`)) {
                                    handleDeleteCategory(cat.id);
                                  }
                                }}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {/* Add Category */}
                  <div className="px-4 py-3 border-t border-border space-y-2">
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={newCategoryColor}
                        onChange={(e) => setNewCategoryColor(e.target.value)}
                        className="h-7 w-7 rounded border border-border cursor-pointer bg-transparent p-0.5"
                      />
                      <input
                        type="text"
                        value={newCategoryIcon}
                        onChange={(e) => setNewCategoryIcon(e.target.value)}
                        placeholder="🏷️"
                        className="h-7 w-10 text-center text-sm rounded-md bg-muted border border-border"
                      />
                      <input
                        type="text"
                        value={newCategoryName}
                        onChange={(e) => setNewCategoryName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleCreateCategory(); }}
                        placeholder="New category name..."
                        className="h-7 text-sm rounded-md bg-muted border border-border px-2 flex-1"
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        disabled={categoryActionLoading || !newCategoryName.trim()}
                        onClick={handleCreateCategory}
                      >
                        Add
                      </Button>
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      Select 2+ categories and click Merge to combine duplicates. Pencil icon to rename.
                    </p>
                  </div>
                </div>
              )}

              {/* Activity Manager */}
              {showCategoryManager && filteredActivities.length > 0 && (
                <div className="bg-card border border-border rounded-lg">
                  <div className="px-4 py-3 border-b border-border flex items-center justify-between flex-wrap gap-2">
                    <h3 className="text-sm font-medium">Activities</h3>
                    <div className="flex items-center gap-2">
                      <select
                        value={activityFilterCategory}
                        onChange={(e) => { setActivityFilterCategory(e.target.value); setActivityMergeSelections(new Set()); setActivityMergeTarget(''); }}
                        className="h-7 text-xs rounded-md bg-muted border border-border px-2"
                      >
                        <option value="">All Categories</option>
                        {categories.map(c => (
                          <option key={c.id} value={c.name}>{c.icon || ''} {c.name}</option>
                        ))}
                      </select>
                      {activityMergeSelections.size >= 2 && (
                        <>
                          <span className="text-xs text-muted-foreground">
                            Merge {activityMergeSelections.size} into:
                          </span>
                          <select
                            value={activityMergeTarget}
                            onChange={(e) => setActivityMergeTarget(e.target.value)}
                            className="h-7 text-xs rounded-md bg-muted border border-border px-2"
                          >
                            {Array.from(activityMergeSelections).map(name => (
                              <option key={name} value={name}>{name}</option>
                            ))}
                          </select>
                          <Button
                            variant="default"
                            size="sm"
                            className="h-7 text-xs"
                            disabled={categoryActionLoading}
                            onClick={handleMergeActivities}
                          >
                            <Merge className="h-3 w-3 mr-1" />
                            Merge
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => { setActivityMergeSelections(new Set()); setActivityMergeTarget(''); }}
                          >
                            Cancel
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="divide-y divide-border max-h-[400px] overflow-y-auto">
                    {filteredActivities.map((act) => {
                      const isSelected = activityMergeSelections.has(act.activity);
                      const isRenaming = renamingActivity === act.activity;
                      const catColor = colors[act.category] || '#888';
                      return (
                        <div
                          key={`${act.category}:${act.activity}`}
                          className={cn(
                            'flex items-center gap-3 px-4 py-2 transition-colors',
                            isSelected && 'bg-primary/5'
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleActivityMergeSelection(act.activity)}
                            className="h-3.5 w-3.5 rounded border-border accent-primary flex-shrink-0"
                          />
                          <div
                            className="w-2 h-2 rounded-full flex-shrink-0"
                            style={{ backgroundColor: catColor }}
                          />
                          {isRenaming ? (
                            <div className="flex items-center gap-1.5 flex-1">
                              <input
                                type="text"
                                value={activityRenameValue}
                                onChange={(e) => setActivityRenameValue(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') handleRenameActivity(act.activity);
                                  if (e.key === 'Escape') setRenamingActivity(null);
                                }}
                                className="h-7 text-sm rounded-md bg-muted border border-border px-2 flex-1"
                                autoFocus
                              />
                              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={categoryActionLoading} onClick={() => handleRenameActivity(act.activity)}>
                                <Check className="h-3.5 w-3.5 text-green-500" />
                              </Button>
                              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setRenamingActivity(null)}>
                                <X className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          ) : (
                            <span className="text-sm flex-1 min-w-0 truncate">{act.activity}</span>
                          )}
                          {!activityFilterCategory && (
                            <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded flex-shrink-0">
                              {act.category}
                            </span>
                          )}
                          <span className="text-xs text-muted-foreground tabular-nums flex-shrink-0">
                            {act.count}×
                          </span>
                          {!isRenaming && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                              onClick={() => { setRenamingActivity(act.activity); setActivityRenameValue(act.activity); }}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div className="px-4 py-2 border-t border-border">
                    <p className="text-[11px] text-muted-foreground">
                      Select 2+ activities and click Merge to combine duplicates. Filter by category to focus cleanup.
                    </p>
                  </div>
                </div>
              )}

              {/* Recent entries table */}
              <div className="bg-card border border-border rounded-lg">
                <div className="px-4 py-3 border-b border-border">
                  <h3 className="text-sm font-medium">Recent Entries ({entries.length})</h3>
                </div>
                {entries.length === 0 ? (
                  <div className="text-center py-12 text-muted-foreground">
                    <Activity className="h-8 w-8 mx-auto mb-2 opacity-30" />
                    <p className="text-sm">No habit entries yet</p>
                    <p className="text-xs mt-1">Text your Choom via Signal to start logging activities</p>
                  </div>
                ) : (
                  <div className="divide-y divide-border">
                    {entries.map((entry) => {
                      const time = new Date(entry.timestamp).toLocaleString('en-US', {
                        weekday: 'short',
                        month: 'short',
                        day: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                      });
                      const icon = icons[entry.category] || '•';
                      const color = colors[entry.category];
                      return (
                        <div
                          key={entry.id}
                          className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/30 transition-colors group"
                        >
                          <span className="text-lg w-6 text-center flex-shrink-0">{icon}</span>
                          <div
                            className="w-2 h-2 rounded-full flex-shrink-0"
                            style={{ backgroundColor: color }}
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium truncate">{entry.activity}</span>
                              <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                                {entry.category}
                              </span>
                            </div>
                            <div className="text-xs text-muted-foreground flex items-center gap-2">
                              <span>{time}</span>
                              {entry.location && <span>at {entry.location}</span>}
                              {entry.quantity != null && entry.unit && (
                                <span>
                                  {entry.quantity} {entry.unit}
                                </span>
                              )}
                            </div>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="opacity-0 group-hover:opacity-100 h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                            onClick={() => handleDelete(entry.id)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

// =============================================================================
// StatCard
// =============================================================================

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: number | string }) {
  return (
    <div className="bg-card border border-border rounded-lg p-3">
      <div className="flex items-center gap-2 text-muted-foreground mb-1">
        {icon}
        <span className="text-xs">{label}</span>
      </div>
      <div className="text-xl font-bold">{value}</div>
    </div>
  );
}
