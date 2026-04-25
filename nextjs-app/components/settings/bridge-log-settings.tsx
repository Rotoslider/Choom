'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileText, RefreshCw, Pause, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type LogLevel = 'ALL' | 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';

interface LogResponse {
  path: string;
  exists: boolean;
  size_bytes?: number;
  modified?: string;
  total_in_window?: number;
  returned?: number;
  lines?: string[];
  message?: string;
  error?: string;
}

const LEVEL_RE = /\s-\s(DEBUG|INFO|WARNING|ERROR|CRITICAL)\s-\s/;

function classForLine(line: string): string {
  const m = line.match(LEVEL_RE);
  switch (m?.[1]) {
    case 'ERROR':
    case 'CRITICAL':
      return 'text-red-500';
    case 'WARNING':
      return 'text-amber-500';
    case 'INFO':
      return 'text-foreground';
    case 'DEBUG':
      return 'text-muted-foreground';
    default:
      return 'text-muted-foreground';
  }
}

export function BridgeLogSettings() {
  const [resp, setResp] = useState<LogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [level, setLevel] = useState<LogLevel>('INFO');
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(500);
  const [stickToBottom, setStickToBottom] = useState(true);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const fetchLog = useCallback(
    async (silent = false) => {
      if (!silent) setRefreshing(true);
      try {
        const params = new URLSearchParams({ limit: String(limit), level });
        if (search) params.set('q', search);
        const res = await fetch(`/api/bridge-log?${params}`, { cache: 'no-store' });
        if (res.ok) setResp(await res.json());
        else setResp({ path: '', exists: false, error: `HTTP ${res.status}` });
      } catch (err) {
        setResp({ path: '', exists: false, error: err instanceof Error ? err.message : 'fetch failed' });
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [level, search, limit],
  );

  useEffect(() => {
    fetchLog();
  }, [fetchLog]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => fetchLog(true), 5_000);
    return () => clearInterval(id);
  }, [autoRefresh, fetchLog]);

  useEffect(() => {
    if (!stickToBottom) return;
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [resp, stickToBottom]);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const atBottom = el.scrollHeight - el.clientHeight - el.scrollTop < 40;
    setStickToBottom(atBottom);
  };

  const sizeKb = useMemo(() => (resp?.size_bytes ? Math.round(resp.size_bytes / 1024) : 0), [resp]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-lg font-medium flex items-center gap-2">
          <FileText className="h-5 w-5" />
          Bridge Log
        </h3>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            size="sm"
            variant={autoRefresh ? 'default' : 'outline'}
            onClick={() => setAutoRefresh((v) => !v)}
            title={autoRefresh ? 'Pause auto-refresh' : 'Resume auto-refresh'}
          >
            {autoRefresh ? <Pause className="h-4 w-4 mr-1" /> : <Play className="h-4 w-4 mr-1" />}
            {autoRefresh ? 'Live' : 'Paused'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => fetchLog()} disabled={refreshing}>
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground break-all font-mono">
        {resp?.path || ''}
        {resp?.exists ? (
          <>
            {' '}
            · {sizeKb} KB · modified {resp.modified ? new Date(resp.modified).toLocaleTimeString() : '—'}
          </>
        ) : null}
      </p>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex gap-1">
          {(['ALL', 'DEBUG', 'INFO', 'WARNING', 'ERROR'] as LogLevel[]).map((lvl) => (
            <Button
              key={lvl}
              size="sm"
              variant={level === lvl ? 'default' : 'outline'}
              onClick={() => setLevel(lvl)}
              className="h-7 px-2 text-xs"
            >
              {lvl}
            </Button>
          ))}
        </div>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter (e.g. self_followup, Eve, error)"
          className="h-7 text-xs flex-1 min-w-[180px]"
        />
        <select
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
          className="h-7 px-2 text-xs rounded border bg-background"
          aria-label="Line limit"
        >
          <option value={200}>200 lines</option>
          <option value={500}>500 lines</option>
          <option value={1000}>1000 lines</option>
          <option value={2000}>2000 lines</option>
        </select>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : resp?.error ? (
        <div className="text-sm text-red-500 p-3 border border-red-500/40 rounded">
          Error: {resp.error}
        </div>
      ) : !resp?.exists ? (
        <div className="text-sm text-muted-foreground italic p-3 border rounded">
          {resp?.message || 'Log file not found yet. Restart the bridge to create it.'}
        </div>
      ) : (
        <>
          <div
            ref={scrollerRef}
            onScroll={onScroll}
            className="font-mono text-[11px] leading-snug border rounded bg-muted/20 p-2 overflow-auto"
            style={{ height: '50vh' }}
          >
            {resp.lines && resp.lines.length > 0 ? (
              resp.lines.map((line, i) => (
                <div key={i} className={`whitespace-pre-wrap break-all ${classForLine(line)}`}>
                  {line}
                </div>
              ))
            ) : (
              <p className="text-muted-foreground italic">No lines match the current filter.</p>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Showing {resp.returned ?? 0} of {resp.total_in_window ?? 0} lines in view
            {!stickToBottom ? ' · auto-scroll paused (scroll to bottom to resume)' : ''}
          </p>
        </>
      )}
    </div>
  );
}
