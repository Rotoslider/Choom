'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  Brain,
  Search,
  Loader2,
  Database,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { MemoryCard } from '@/components/memories/memory-card';
import { MemoryDetailPanel } from '@/components/memories/memory-detail-panel';
import { QuickCapture } from '@/components/memories/quick-capture';
import { useAppStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import type { Memory, MemoryType, MemoryStats, Choom } from '@/lib/types';

type FilterType = 'all' | MemoryType;

const FILTER_BUTTONS: { id: FilterType; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'fact', label: 'Facts' },
  { id: 'conversation', label: 'Conversations' },
  { id: 'preference', label: 'Preferences' },
  { id: 'event', label: 'Events' },
  { id: 'task', label: 'Tasks' },
  { id: 'ephemeral', label: 'Ephemeral' },
];

export default function MemoriesPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const settings = useAppStore((state) => state.settings);
  const memoryEndpoint = settings?.memory?.endpoint || 'http://localhost:8100';

  const [memories, setMemories] = useState<Memory[]>([]);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<FilterType>('all');
  const [selectedMemoryId, setSelectedMemoryId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chooms, setChooms] = useState<Choom[]>([]);
  const [selectedChoomId, setSelectedChoomId] = useState<string>('all');
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const headers = { 'x-memory-endpoint': memoryEndpoint };

  // The companion_id used for memory scoping (choom.companionId or choom.id)
  const activeCompanionId = selectedChoomId === 'all'
    ? undefined
    : chooms.find((c) => c.id === selectedChoomId)?.companionId || selectedChoomId;

  // Fetch Choom list
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/chooms');
        if (res.ok) {
          const data = await res.json();
          setChooms(Array.isArray(data) ? data : []);
        }
      } catch { /* ignore */ }
    })();
  }, []);

  // Handle ?id= query parameter (from Cmd+K navigation)
  useEffect(() => {
    const idParam = searchParams.get('id');
    if (idParam) {
      setSelectedMemoryId(idParam);
      router.replace('/memories', { scroll: false });
    }
  }, [searchParams, router]);

  // Fetch memories based on current filters
  const fetchMemories = useCallback(async (opts?: { query?: string; type?: FilterType; choomId?: string; silent?: boolean }) => {
    const q = opts?.query ?? searchQuery;
    const t = opts?.type ?? filterType;
    const cid = opts?.choomId !== undefined ? opts.choomId : activeCompanionId;
    if (!opts?.silent) setLoading(true);
    setError(null);

    try {
      let res;
      if (q.trim()) {
        // Semantic search
        res = await fetch('/api/memories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({ action: 'search', query: q, limit: 50, companion_id: cid }),
        });
      } else if (t !== 'all') {
        // Filter by type
        res = await fetch('/api/memories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({ action: 'search_by_type', memory_type: t, limit: 100, companion_id: cid }),
        });
      } else {
        // Recent
        const cidParam = cid ? `&companion_id=${encodeURIComponent(cid)}` : '';
        res = await fetch(`/api/memories?action=recent&limit=100${cidParam}`, { headers });
      }

      if (res.ok) {
        const data = await res.json();
        if (data.success === false) {
          setError(data.reason || 'Failed to fetch memories');
          setMemories([]);
        } else {
          setMemories(data.data || []);
        }
      } else {
        setError('Memory server unavailable');
        setMemories([]);
      }
    } catch {
      setError('Could not connect to memory server');
      setMemories([]);
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, filterType, memoryEndpoint, activeCompanionId]);

  // Fetch stats
  const fetchStats = useCallback(async () => {
    try {
      const cidParam = activeCompanionId ? `&companion_id=${encodeURIComponent(activeCompanionId)}` : '';
      const res = await fetch(`/api/memories?action=stats${cidParam}`, { headers });
      if (res.ok) {
        const data = await res.json();
        if (data.data) {
          // Stats can come as data object or data array with one element
          setStats(Array.isArray(data.data) ? data.data[0] : data.data);
        }
      }
    } catch { /* ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memoryEndpoint, activeCompanionId]);

  // Initial load
  useEffect(() => {
    fetchMemories();
    fetchStats();
  }, [fetchMemories, fetchStats]);

  // Debounced search
  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchMemories({ query: searchQuery });
    }, 300);
    return () => clearTimeout(debounceRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);

  // Type filter change
  const handleFilterChange = (type: FilterType) => {
    setFilterType(type);
    setSearchQuery('');
    fetchMemories({ query: '', type });
  };

  // Choom filter change
  const handleChoomChange = (choomId: string) => {
    setSelectedChoomId(choomId);
    const cid = choomId === 'all'
      ? undefined
      : chooms.find((c) => c.id === choomId)?.companionId || choomId;
    fetchMemories({ choomId: cid });
    // Re-fetch stats with new companion_id — will happen via useEffect on activeCompanionId change
  };

  const handleSelect = (id: string) => {
    setSelectedMemoryId((prev) => (prev === id ? null : id));
  };

  const handleUpdated = (updated: Memory) => {
    setMemories((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
  };

  const handleDeleted = (id: string) => {
    setMemories((prev) => prev.filter((m) => m.id !== id));
    setSelectedMemoryId(null);
    fetchStats();
  };

  const handleCaptured = () => {
    fetchMemories({ silent: true });
    fetchStats();
  };

  const selectedMemory = memories.find((m) => m.id === selectedMemoryId);

  // Type counts from current data
  const typeCounts: Record<string, number> = {};
  if (stats?.type_breakdown) {
    Object.assign(typeCounts, stats.type_breakdown);
  }

  return (
    <div className="min-h-screen bg-background flex">
      {/* Main content area */}
      <div className={cn('flex-1 flex flex-col min-h-screen', selectedMemory && 'lg:mr-[420px]')}>
        {/* Header */}
        <header className="border-b border-border bg-card px-6 py-4">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => router.push('/')}
                className="-ml-2"
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <div>
                <h1 className="text-lg font-semibold flex items-center gap-2">
                  <Brain className="h-5 w-5" />
                  Second Brain
                </h1>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {stats ? (
                    <>
                      {stats.total_memories} memories / {stats.storage_size_mb?.toFixed(1) || '?'} MB
                      <span className="ml-2 opacity-60">
                        Avg importance: {stats.avg_importance?.toFixed(1) || '?'}
                      </span>
                    </>
                  ) : (
                    'Loading...'
                  )}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <kbd className="hidden sm:inline-flex text-[10px] text-muted-foreground border border-border rounded px-1.5 py-0.5">
                Cmd+K
              </kbd>
              <Button
                variant="outline"
                size="sm"
                onClick={() => { fetchMemories(); fetchStats(); }}
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Search + filter bar */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative flex-1 max-w-sm min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search memories (semantic)..."
                className="pl-9 h-8 text-sm"
              />
            </div>

            {/* Choom filter */}
            {chooms.length > 1 && (
              <select
                value={selectedChoomId}
                onChange={(e) => handleChoomChange(e.target.value)}
                className="h-8 text-xs rounded-md bg-muted border border-border px-2 min-w-[120px]"
              >
                <option value="all">All Chooms</option>
                {chooms.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            )}

            <div className="flex items-center gap-1 rounded-lg border border-border p-0.5 overflow-x-auto">
              {FILTER_BUTTONS.map((fb) => (
                <button
                  key={fb.id}
                  onClick={() => handleFilterChange(fb.id)}
                  className={cn(
                    'px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap',
                    filterType === fb.id
                      ? 'bg-primary/15 text-primary'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                  )}
                >
                  {fb.label}
                  {fb.id !== 'all' && typeCounts[fb.id] !== undefined && (
                    <span className="ml-1 opacity-60">{typeCounts[fb.id]}</span>
                  )}
                  {fb.id === 'all' && stats && (
                    <span className="ml-1 opacity-60">{stats.total_memories}</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </header>

        {/* Quick Capture */}
        <QuickCapture memoryEndpoint={memoryEndpoint} companionId={activeCompanionId} onCaptured={handleCaptured} />

        {/* Memory grid */}
        <ScrollArea className="flex-1">
          <div className="p-6">
            {error ? (
              <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                <Database className="h-8 w-8 mb-3 opacity-30" />
                <p className="text-sm font-medium mb-1">Memory Server Unavailable</p>
                <p className="text-xs">{error}</p>
                <Button variant="outline" size="sm" className="mt-4" onClick={() => fetchMemories()}>
                  Retry
                </Button>
              </div>
            ) : loading ? (
              <div className="flex items-center justify-center py-16 text-muted-foreground">
                <Loader2 className="h-6 w-6 animate-spin mr-2" />
                Loading memories...
              </div>
            ) : memories.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                <Brain className="h-8 w-8 mb-3 opacity-30" />
                <p className="text-sm font-medium mb-1">
                  {searchQuery ? 'No memories found' : 'No memories yet'}
                </p>
                <p className="text-xs">
                  {searchQuery
                    ? 'Try a different search or clear filters'
                    : 'Use Quick Capture above or text your Choom via Signal to start building your second brain'}
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                {memories.map((memory) => (
                  <MemoryCard
                    key={memory.id}
                    memory={memory}
                    selected={selectedMemoryId === memory.id}
                    onClick={() => handleSelect(memory.id)}
                  />
                ))}
              </div>
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Detail panel (right side — desktop) */}
      {selectedMemory && (
        <aside className="fixed right-0 top-0 bottom-0 w-[420px] border-l border-border bg-card z-10 hidden lg:flex flex-col">
          <MemoryDetailPanel
            memory={selectedMemory}
            memoryEndpoint={memoryEndpoint}
            onClose={() => setSelectedMemoryId(null)}
            onUpdated={handleUpdated}
            onDeleted={handleDeleted}
          />
        </aside>
      )}

      {/* Detail panel (overlay — mobile) */}
      {selectedMemory && (
        <div className="lg:hidden fixed inset-0 z-50">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setSelectedMemoryId(null)}
          />
          <aside className="absolute right-0 top-0 bottom-0 w-full max-w-md bg-card border-l border-border flex flex-col animate-in slide-in-from-right">
            <MemoryDetailPanel
              memory={selectedMemory}
              memoryEndpoint={memoryEndpoint}
              onClose={() => setSelectedMemoryId(null)}
              onUpdated={handleUpdated}
              onDeleted={handleDeleted}
            />
          </aside>
        </div>
      )}
    </div>
  );
}
