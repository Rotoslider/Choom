'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Gauge,
  RefreshCw,
  Loader2,
  Zap,
  Clock,
  MessageSquare,
  Wrench,
  DollarSign,
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
  Legend,
  AreaChart,
  Area,
} from 'recharts';

// =============================================================================
// Types
// =============================================================================

interface BreakdownEntry {
  name?: string;
  prompt: number;
  completion: number;
  total: number;
  requests: number;
}

interface UsageStats {
  totalRequests: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalDurationMs: number;
  totalIterations: number;
  totalToolCalls: number;
  avgTokensPerRequest: number;
  avgDurationMs: number;
  byChoom: Record<string, BreakdownEntry>;
  byModel: Record<string, BreakdownEntry>;
  byProvider: Record<string, BreakdownEntry>;
  bySource: Record<string, BreakdownEntry>;
  daily: Record<string, BreakdownEntry>;
}

interface FilterOptions {
  chooms: { id: string; name: string }[];
  models: string[];
  providers: string[];
}

type Period = 'day' | 'week' | 'month' | 'year' | 'all';

const PERIOD_OPTIONS: { id: Period; label: string }[] = [
  { id: 'day', label: 'Today' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'year', label: 'Year' },
  { id: 'all', label: 'All Time' },
];

const CHOOM_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316'];
const MODEL_COLORS = ['#0ea5e9', '#14b8a6', '#a855f7', '#f43f5e', '#eab308', '#6366f1', '#84cc16', '#fb923c'];
const SOURCE_COLORS: Record<string, string> = {
  chat: '#3b82f6',
  delegation: '#8b5cf6',
  heartbeat: '#22c55e',
  compaction: '#f59e0b',
};

// Approximate cost estimates (per 1M tokens)
const COST_ESTIMATES: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-20250514': { input: 3.0, output: 15.0 },
  'claude-3-5-sonnet': { input: 3.0, output: 15.0 },
  'claude-3-haiku': { input: 0.25, output: 1.25 },
  'gpt-4o': { input: 2.5, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
};

function estimateCost(model: string, promptTokens: number, completionTokens: number): number | null {
  // Find matching cost entry (partial match)
  const key = Object.keys(COST_ESTIMATES).find(k => model.toLowerCase().includes(k.toLowerCase()));
  if (!key) return null;
  const rates = COST_ESTIMATES[key];
  return (promptTokens * rates.input + completionTokens * rates.output) / 1_000_000;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toString();
}

function formatDuration(ms: number): string {
  if (ms >= 60_000) return (ms / 60_000).toFixed(1) + 'min';
  return (ms / 1000).toFixed(1) + 's';
}

// =============================================================================
// Main Page
// =============================================================================

export default function UsagePage() {
  const router = useRouter();
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [filters, setFilters] = useState<FilterOptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<Period>('month');
  const [filterChoom, setFilterChoom] = useState('');
  const [filterModel, setFilterModel] = useState('');
  const [filterProvider, setFilterProvider] = useState('');
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ action: 'stats', period });
      if (filterChoom) params.set('choomId', filterChoom);
      if (filterModel) params.set('model', filterModel);
      if (filterProvider) params.set('provider', filterProvider);

      const [statsRes, filtersRes] = await Promise.all([
        fetch(`/api/token-usage?${params}`),
        fetch('/api/token-usage?action=filters'),
      ]);

      if (statsRes.ok) {
        const d = await statsRes.json();
        setStats(d.data || null);
      }
      if (filtersRes.ok) {
        const d = await filtersRes.json();
        setFilters(d.data || null);
      }
    } catch {
      setError('Failed to load usage data');
    } finally {
      setLoading(false);
    }
  }, [period, filterChoom, filterModel, filterProvider]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Chart data transforms
  const choomPieData = stats
    ? Object.entries(stats.byChoom).map(([id, v], i) => ({
        name: v.name || id.slice(0, 8),
        value: v.total,
        requests: v.requests,
        color: CHOOM_COLORS[i % CHOOM_COLORS.length],
      }))
    : [];

  const modelBarData = stats
    ? Object.entries(stats.byModel)
        .sort(([, a], [, b]) => b.total - a.total)
        .map(([name, v], i) => ({
          name: name.length > 30 ? name.slice(0, 30) + '...' : name,
          fullName: name,
          prompt: v.prompt,
          completion: v.completion,
          total: v.total,
          requests: v.requests,
          color: MODEL_COLORS[i % MODEL_COLORS.length],
        }))
    : [];

  const providerBarData = stats
    ? Object.entries(stats.byProvider)
        .sort(([, a], [, b]) => b.total - a.total)
        .map(([name, v]) => ({
          name,
          prompt: v.prompt,
          completion: v.completion,
          total: v.total,
          requests: v.requests,
        }))
    : [];

  const dailyData = stats
    ? Object.entries(stats.daily)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, v]) => ({
          date: date.slice(5), // MM-DD
          fullDate: date,
          prompt: v.prompt,
          completion: v.completion,
          total: v.total,
          requests: v.requests,
        }))
    : [];

  const sourceData = stats
    ? Object.entries(stats.bySource).map(([name, v]) => ({
        name,
        value: v.total,
        requests: v.requests,
        color: SOURCE_COLORS[name] || '#888',
      }))
    : [];

  // Cost estimate
  const totalEstimatedCost = stats
    ? Object.entries(stats.byModel).reduce((sum, [model, v]) => {
        const cost = estimateCost(model, v.prompt, v.completion);
        return sum + (cost || 0);
      }, 0)
    : 0;

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
                <Gauge className="h-5 w-5" />
                Token Usage
              </h1>
              <p className="text-xs text-muted-foreground mt-0.5">
                {stats ? (
                  <>
                    {stats.totalRequests} requests | {formatTokens(stats.totalTokens)} tokens
                    {totalEstimatedCost > 0 && (
                      <span className="ml-2">
                        | ~${totalEstimatedCost.toFixed(2)} estimated
                      </span>
                    )}
                  </>
                ) : (
                  'Loading...'
                )}
              </p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={fetchData}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-3 flex-wrap">
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

          {filters && filters.chooms.length > 1 && (
            <select
              value={filterChoom}
              onChange={(e) => setFilterChoom(e.target.value)}
              className="h-8 text-xs rounded-md bg-muted border border-border px-2 min-w-[120px]"
            >
              <option value="">All Chooms</option>
              {filters.chooms.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          )}

          {filters && filters.models.length > 1 && (
            <select
              value={filterModel}
              onChange={(e) => setFilterModel(e.target.value)}
              className="h-8 text-xs rounded-md bg-muted border border-border px-2 min-w-[120px]"
            >
              <option value="">All Models</option>
              {filters.models.map((m) => (
                <option key={m} value={m}>{m.length > 30 ? m.slice(0, 30) + '...' : m}</option>
              ))}
            </select>
          )}

          {filters && filters.providers.length > 1 && (
            <select
              value={filterProvider}
              onChange={(e) => setFilterProvider(e.target.value)}
              className="h-8 text-xs rounded-md bg-muted border border-border px-2 min-w-[120px]"
            >
              <option value="">All Providers</option>
              {filters.providers.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          )}
        </div>
      </header>

      {/* Content */}
      <ScrollArea className="flex-1">
        <div className="p-6 space-y-6">
          {error ? (
            <div className="text-center py-16 text-muted-foreground">
              <p className="text-sm">{error}</p>
              <Button variant="outline" size="sm" className="mt-4" onClick={fetchData}>Retry</Button>
            </div>
          ) : loading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin mr-2" />
              Loading usage data...
            </div>
          ) : !stats || stats.totalRequests === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <Gauge className="h-8 w-8 mx-auto mb-2 opacity-30" />
              <p className="text-sm">No usage data yet</p>
              <p className="text-xs mt-1">Token counts will appear here after your next chat</p>
            </div>
          ) : (
            <>
              {/* Stat cards */}
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                <StatCard
                  icon={<Zap className="h-4 w-4 text-yellow-500" />}
                  label="Total Tokens"
                  value={formatTokens(stats.totalTokens)}
                  sub={`${formatTokens(stats.totalPromptTokens)} in / ${formatTokens(stats.totalCompletionTokens)} out`}
                />
                <StatCard
                  icon={<MessageSquare className="h-4 w-4 text-blue-500" />}
                  label="Requests"
                  value={stats.totalRequests}
                  sub={`${stats.avgTokensPerRequest.toLocaleString()} avg tokens`}
                />
                <StatCard
                  icon={<Clock className="h-4 w-4 text-green-500" />}
                  label="Total Time"
                  value={formatDuration(stats.totalDurationMs)}
                  sub={`${formatDuration(stats.avgDurationMs)} avg`}
                />
                <StatCard
                  icon={<Wrench className="h-4 w-4 text-purple-500" />}
                  label="Tool Calls"
                  value={stats.totalToolCalls}
                  sub={`${stats.totalIterations} iterations`}
                />
                {totalEstimatedCost > 0 && (
                  <StatCard
                    icon={<DollarSign className="h-4 w-4 text-emerald-500" />}
                    label="Est. Cost"
                    value={`$${totalEstimatedCost.toFixed(2)}`}
                    sub="paid providers only"
                  />
                )}
              </div>

              {/* Daily trend */}
              {dailyData.length > 0 && (
                <div className="bg-card border border-border rounded-lg p-4">
                  <h3 className="text-sm font-medium mb-3">Daily Token Usage</h3>
                  <ResponsiveContainer width="100%" height={220}>
                    <AreaChart data={dailyData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} stroke="var(--border)" />
                      <YAxis
                        tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
                        stroke="var(--border)"
                        tickFormatter={(v) => formatTokens(v)}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: 'var(--card)',
                          border: '1px solid var(--border)',
                          borderRadius: 8,
                          fontSize: 12,
                        }}
                        formatter={(value: number, name: string) => [formatTokens(value), name]}
                      />
                      <Area type="monotone" dataKey="prompt" stackId="1" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.3} name="Prompt" />
                      <Area type="monotone" dataKey="completion" stackId="1" stroke="#22c55e" fill="#22c55e" fillOpacity={0.3} name="Completion" />
                      <Legend />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}

              {/* Row: By Choom + By Source */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* By Choom */}
                {choomPieData.length > 0 && (
                  <div className="bg-card border border-border rounded-lg p-4">
                    <h3 className="text-sm font-medium mb-3">By Choom</h3>
                    <ResponsiveContainer width="100%" height={260}>
                      <PieChart>
                        <Pie
                          data={choomPieData}
                          cx="50%"
                          cy="50%"
                          innerRadius={45}
                          outerRadius={80}
                          dataKey="value"
                          nameKey="name"
                          label={({ name, value, cx, cy, midAngle, outerRadius: oR }) => {
                            const RADIAN = Math.PI / 180;
                            const radius = (oR as number) + 25;
                            const x = (cx as number) + radius * Math.cos(-midAngle * RADIAN);
                            const y = (cy as number) + radius * Math.sin(-midAngle * RADIAN);
                            return (
                              <text
                                x={x}
                                y={y}
                                fill="var(--foreground)"
                                textAnchor={x > (cx as number) ? 'start' : 'end'}
                                dominantBaseline="central"
                                fontSize={12}
                              >
                                {`${name} (${formatTokens(value as number)})`}
                              </text>
                            );
                          }}
                          labelLine={{ stroke: 'var(--muted-foreground)', strokeWidth: 1 }}
                        >
                          {choomPieData.map((entry, i) => (
                            <Cell key={i} fill={entry.color} />
                          ))}
                        </Pie>
                        <Tooltip formatter={(value: number) => formatTokens(value)} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                )}

                {/* By Source */}
                {sourceData.length > 0 && (
                  <div className="bg-card border border-border rounded-lg p-4">
                    <h3 className="text-sm font-medium mb-3">By Source</h3>
                    <ResponsiveContainer width="100%" height={260}>
                      <PieChart>
                        <Pie
                          data={sourceData}
                          cx="50%"
                          cy="50%"
                          innerRadius={45}
                          outerRadius={80}
                          dataKey="value"
                          nameKey="name"
                          label={({ name, value, cx, cy, midAngle, outerRadius: oR }) => {
                            const RADIAN = Math.PI / 180;
                            const radius = (oR as number) + 25;
                            const x = (cx as number) + radius * Math.cos(-midAngle * RADIAN);
                            const y = (cy as number) + radius * Math.sin(-midAngle * RADIAN);
                            return (
                              <text
                                x={x}
                                y={y}
                                fill="var(--foreground)"
                                textAnchor={x > (cx as number) ? 'start' : 'end'}
                                dominantBaseline="central"
                                fontSize={12}
                              >
                                {`${name} (${formatTokens(value as number)})`}
                              </text>
                            );
                          }}
                          labelLine={{ stroke: 'var(--muted-foreground)', strokeWidth: 1 }}
                        >
                          {sourceData.map((entry, i) => (
                            <Cell key={i} fill={entry.color} />
                          ))}
                        </Pie>
                        <Tooltip formatter={(value: number) => formatTokens(value)} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>

              {/* By Model - horizontal bar chart */}
              {modelBarData.length > 0 && (
                <div className="bg-card border border-border rounded-lg p-4">
                  <h3 className="text-sm font-medium mb-3">By Model</h3>
                  <ResponsiveContainer width="100%" height={Math.max(150, modelBarData.length * 40)}>
                    <BarChart data={modelBarData} layout="vertical" margin={{ left: 150 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis
                        type="number"
                        tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
                        stroke="var(--border)"
                        tickFormatter={(v) => formatTokens(v)}
                      />
                      <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: 'var(--foreground)' }} stroke="var(--border)" width={150} />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: 'var(--card)',
                          border: '1px solid var(--border)',
                          borderRadius: 8,
                          fontSize: 12,
                        }}
                        formatter={(value: number, name: string) => [formatTokens(value), name]}
                      />
                      <Bar dataKey="prompt" stackId="1" fill="#3b82f6" name="Prompt" />
                      <Bar dataKey="completion" stackId="1" fill="#22c55e" name="Completion" radius={[0, 4, 4, 0]} />
                      <Legend />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}

              {/* By Provider */}
              {providerBarData.length > 0 && (
                <div className="bg-card border border-border rounded-lg p-4">
                  <h3 className="text-sm font-medium mb-3">By Provider</h3>
                  <ResponsiveContainer width="100%" height={Math.max(100, providerBarData.length * 40)}>
                    <BarChart data={providerBarData} layout="vertical" margin={{ left: 80 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis
                        type="number"
                        tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
                        stroke="var(--border)"
                        tickFormatter={(v) => formatTokens(v)}
                      />
                      <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: 'var(--foreground)' }} stroke="var(--border)" width={80} />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: 'var(--card)',
                          border: '1px solid var(--border)',
                          borderRadius: 8,
                          fontSize: 12,
                        }}
                        labelFormatter={(label) => `Provider: ${label}`}
                        formatter={(value: number, name: string) => [formatTokens(value), name]}
                      />
                      <Bar dataKey="prompt" stackId="1" fill="#3b82f6" name="Prompt" />
                      <Bar dataKey="completion" stackId="1" fill="#22c55e" name="Completion" radius={[0, 4, 4, 0]} />
                      <Legend />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}

              {/* Cost breakdown table (only for paid models) */}
              {totalEstimatedCost > 0 && (
                <div className="bg-card border border-border rounded-lg">
                  <div className="px-4 py-3 border-b border-border">
                    <h3 className="text-sm font-medium">Cost Estimates (Paid Providers)</h3>
                    <p className="text-xs text-muted-foreground mt-0.5">Based on published pricing. Local models show as $0.</p>
                  </div>
                  <div className="divide-y divide-border">
                    {Object.entries(stats.byModel).map(([model, v]) => {
                      const cost = estimateCost(model, v.prompt, v.completion);
                      return (
                        <div key={model} className="flex items-center justify-between px-4 py-2 text-sm">
                          <div>
                            <span className="font-medium">{model}</span>
                            <span className="text-xs text-muted-foreground ml-2">
                              {v.requests} requests
                            </span>
                          </div>
                          <div className="text-right">
                            <span className="font-mono">
                              {formatTokens(v.total)} tokens
                            </span>
                            {cost !== null && cost > 0 && (
                              <span className="text-xs text-emerald-500 ml-2">
                                ~${cost.toFixed(4)}
                              </span>
                            )}
                            {cost === null && (
                              <span className="text-xs text-muted-foreground ml-2">
                                $0 (local)
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
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

function StatCard({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: number | string; sub?: string }) {
  return (
    <div className="bg-card border border-border rounded-lg p-3">
      <div className="flex items-center gap-2 text-muted-foreground mb-1">
        {icon}
        <span className="text-xs">{label}</span>
      </div>
      <div className="text-xl font-bold">{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}
