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
          <Button variant="outline" size="sm" onClick={fetchAll}>
            <RefreshCw className="h-4 w-4" />
          </Button>
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
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                        <XAxis dataKey="date" tick={{ fontSize: 10 }} stroke="var(--muted-foreground)" />
                        <YAxis allowDecimals={false} tick={{ fontSize: 10 }} stroke="var(--muted-foreground)" />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: 'var(--card)',
                            border: '1px solid var(--border)',
                            borderRadius: 8,
                            fontSize: 12,
                          }}
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
                    <ResponsiveContainer width="100%" height={200}>
                      <PieChart>
                        <Pie
                          data={pieData}
                          cx="50%"
                          cy="50%"
                          innerRadius={40}
                          outerRadius={80}
                          dataKey="value"
                          nameKey="name"
                          label={({ name, value }) => `${name} (${value})`}
                          labelLine={false}
                        >
                          {pieData.map((entry, i) => (
                            <Cell key={i} fill={entry.color} />
                          ))}
                        </Pie>
                        <Tooltip />
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
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis type="number" allowDecimals={false} tick={{ fontSize: 10 }} stroke="var(--muted-foreground)" />
                      <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" width={80} />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: 'var(--card)',
                          border: '1px solid var(--border)',
                          borderRadius: 8,
                          fontSize: 12,
                        }}
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
