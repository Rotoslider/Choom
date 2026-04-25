'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileText, RefreshCw, Pause, Play, Stethoscope, Music, Copy, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type LogLevel = 'ALL' | 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';
type LogSource = 'live' | 'doctor' | 'youtube';

interface LiveLogResponse {
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

interface DoctorReportSummary {
  date: string;
  size: number;
  modified: string;
}

interface DoctorReport {
  formatted_text?: string;
  generated_at?: string;
  total_requests?: number;
  anomalies?: string[];
  [k: string]: unknown;
}

interface YTReportSummary {
  id: string;
  generated_at: string;
  total_downloaded: number;
  total_errors: number;
  channels_run: number;
}

interface YTReport {
  generated_at: string;
  total_downloaded: number;
  total_errors: number;
  channels_run: number;
  formatted_text?: string;
  results?: unknown;
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

function formatStamp(iso?: string): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { return iso; }
}

// ---------- Copy button (works for any preformatted text) ----------
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch { /* fall back to manual select */ }
      }}
      title="Copy to clipboard"
    >
      {copied ? <Check className="h-4 w-4 mr-1" /> : <Copy className="h-4 w-4 mr-1" />}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

// ====================================================================
// LIVE BRIDGE LOG
// ====================================================================
function LiveBridgeLog() {
  const [resp, setResp] = useState<LiveLogResponse | null>(null);
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

  useEffect(() => { fetchLog(); }, [fetchLog]);
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
    setStickToBottom(el.scrollHeight - el.clientHeight - el.scrollTop < 40);
  };

  const sizeKb = useMemo(() => (resp?.size_bytes ? Math.round(resp.size_bytes / 1024) : 0), [resp]);
  const allText = useMemo(() => (resp?.lines || []).join('\n'), [resp]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-xs text-muted-foreground break-all font-mono">
          {resp?.path || ''}
          {resp?.exists ? <> · {sizeKb} KB · modified {formatStamp(resp.modified)}</> : null}
        </p>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant={autoRefresh ? 'default' : 'outline'}
            onClick={() => setAutoRefresh((v) => !v)}
            title={autoRefresh ? 'Pause auto-refresh' : 'Resume auto-refresh'}
          >
            {autoRefresh ? <Pause className="h-4 w-4 mr-1" /> : <Play className="h-4 w-4 mr-1" />}
            {autoRefresh ? 'Live' : 'Paused'}
          </Button>
          {resp?.exists && resp.lines?.length ? <CopyButton text={allText} /> : null}
          <Button size="sm" variant="ghost" onClick={() => fetchLog()} disabled={refreshing}>
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

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
        <div className="text-sm text-red-500 p-3 border border-red-500/40 rounded">Error: {resp.error}</div>
      ) : !resp?.exists ? (
        <div className="text-sm text-muted-foreground italic p-3 border rounded">
          {resp?.message || 'Log file not found yet. Restart the bridge to create it.'}
        </div>
      ) : (
        <>
          <div
            ref={scrollerRef}
            onScroll={onScroll}
            className="font-mono text-[11px] leading-snug border rounded bg-muted/20 p-2 overflow-auto select-text"
            style={{ height: '55vh', userSelect: 'text' }}
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

// ====================================================================
// DOCTOR REPORTS
// ====================================================================
function DoctorReports() {
  const [list, setList] = useState<DoctorReportSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [reportLoading, setReportLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/reports/doctor', { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          setList(data.reports || []);
          if ((data.reports || []).length > 0) setSelected(data.reports[0].date);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'fetch failed');
      } finally {
        setListLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!selected) return;
    setReportLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch(`/api/reports/doctor?date=${selected}`, { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          setReport(data.report);
        } else {
          setError(`HTTP ${res.status}`);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'fetch failed');
      } finally {
        setReportLoading(false);
      }
    })();
  }, [selected]);

  if (listLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (list.length === 0) {
    return (
      <div className="text-sm text-muted-foreground italic p-3 border rounded">
        No doctor reports yet. The nightly doctor runs at 22:00 (configure in Settings → Cron Jobs) and writes a report each night.
      </div>
    );
  }

  const text = report?.formatted_text || '';
  const anomalyCount = report?.anomalies?.length ?? 0;

  return (
    <div className="grid grid-cols-[180px_1fr] gap-3">
      <div className="border rounded overflow-auto" style={{ maxHeight: '60vh' }}>
        <ul className="divide-y text-sm">
          {list.map((r) => (
            <li key={r.date}>
              <button
                onClick={() => setSelected(r.date)}
                className={`w-full text-left px-3 py-2 hover:bg-muted/50 transition-colors ${
                  selected === r.date ? 'bg-primary/10 text-primary font-medium' : ''
                }`}
              >
                <div>{r.date}</div>
                <div className="text-[10px] text-muted-foreground">
                  {Math.round(r.size / 1024)} KB
                </div>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-xs text-muted-foreground">
            {selected ? `Report for ${selected}` : ''}
            {report?.total_requests !== undefined ? ` · ${report.total_requests} requests` : ''}
            {anomalyCount > 0 ? ` · ${anomalyCount} anomalies` : ''}
          </div>
          {text ? <CopyButton text={text} /> : null}
        </div>
        {reportLoading ? (
          <p className="text-sm text-muted-foreground">Loading report…</p>
        ) : error ? (
          <div className="text-sm text-red-500 p-3 border border-red-500/40 rounded">Error: {error}</div>
        ) : text ? (
          <pre
            className="font-mono text-[11px] leading-snug border rounded bg-muted/20 p-3 overflow-auto whitespace-pre-wrap break-words select-text"
            style={{ maxHeight: '60vh', userSelect: 'text' }}
          >
            {text}
          </pre>
        ) : (
          <div className="text-sm text-muted-foreground italic p-3 border rounded">
            This report was generated before formatted-text was stored. Open the JSON directly via{' '}
            <code>data/traces/reports/report-{selected}.json</code> for now; tonight&apos;s report will render here.
          </div>
        )}
      </div>
    </div>
  );
}

// ====================================================================
// YOUTUBE REPORTS
// ====================================================================
function YouTubeReports() {
  const [list, setList] = useState<YTReportSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [report, setReport] = useState<YTReport | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [reportLoading, setReportLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/reports/yt', { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          setList(data.reports || []);
          if ((data.reports || []).length > 0) setSelected(data.reports[0].id);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'fetch failed');
      } finally {
        setListLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!selected) return;
    setReportLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch(`/api/reports/yt?id=${encodeURIComponent(selected)}`, {
          cache: 'no-store',
        });
        if (res.ok) {
          const data = await res.json();
          setReport(data.report);
        } else {
          setError(`HTTP ${res.status}`);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'fetch failed');
      } finally {
        setReportLoading(false);
      }
    })();
  }, [selected]);

  if (listLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (list.length === 0) {
    return (
      <div className="text-sm text-muted-foreground italic p-3 border rounded">
        No YouTube downloader runs yet. Enable it in Settings → Cron Jobs (default 04:00) and add channels in Settings → YouTube DL. Reports appear here after each run.
      </div>
    );
  }

  const text = report?.formatted_text || '';

  return (
    <div className="grid grid-cols-[200px_1fr] gap-3">
      <div className="border rounded overflow-auto" style={{ maxHeight: '60vh' }}>
        <ul className="divide-y text-sm">
          {list.map((r) => (
            <li key={r.id}>
              <button
                onClick={() => setSelected(r.id)}
                className={`w-full text-left px-3 py-2 hover:bg-muted/50 transition-colors ${
                  selected === r.id ? 'bg-primary/10 text-primary font-medium' : ''
                }`}
              >
                <div className="text-xs">{formatStamp(r.generated_at)}</div>
                <div className="text-[10px] text-muted-foreground">
                  {r.total_downloaded} dl · {r.total_errors} err · {r.channels_run} ch
                </div>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-xs text-muted-foreground">
            {selected ? formatStamp(report?.generated_at) : ''}
            {report ? ` · ${report.total_downloaded} downloaded · ${report.total_errors} errors` : ''}
          </div>
          {text ? <CopyButton text={text} /> : null}
        </div>
        {reportLoading ? (
          <p className="text-sm text-muted-foreground">Loading report…</p>
        ) : error ? (
          <div className="text-sm text-red-500 p-3 border border-red-500/40 rounded">Error: {error}</div>
        ) : text ? (
          <pre
            className="font-mono text-[11px] leading-snug border rounded bg-muted/20 p-3 overflow-auto whitespace-pre-wrap break-words select-text"
            style={{ maxHeight: '60vh', userSelect: 'text' }}
          >
            {text}
          </pre>
        ) : (
          <div className="text-sm text-muted-foreground italic p-3 border rounded">
            This run did not produce a formatted summary.
          </div>
        )}
      </div>
    </div>
  );
}

// ====================================================================
// MAIN: Logs hub with sub-tabs
// ====================================================================
export function BridgeLogSettings() {
  const [source, setSource] = useState<LogSource>('live');

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-medium flex items-center gap-2">
          <FileText className="h-5 w-5" />
          Logs
        </h3>
        <p className="text-sm text-muted-foreground mt-1">
          Live bridge log, nightly doctor reports, and YouTube downloader history. All views are
          selectable — drag-highlight and Ctrl+C, or use the Copy button to grab the whole thing.
        </p>
      </div>

      <div className="flex gap-1 border-b">
        <button
          onClick={() => setSource('live')}
          className={`px-3 py-2 text-sm flex items-center gap-1.5 border-b-2 -mb-px transition-colors ${
            source === 'live'
              ? 'border-primary text-primary font-medium'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          <FileText className="h-4 w-4" />
          Live Bridge
        </button>
        <button
          onClick={() => setSource('doctor')}
          className={`px-3 py-2 text-sm flex items-center gap-1.5 border-b-2 -mb-px transition-colors ${
            source === 'doctor'
              ? 'border-primary text-primary font-medium'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          <Stethoscope className="h-4 w-4" />
          Doctor Reports
        </button>
        <button
          onClick={() => setSource('youtube')}
          className={`px-3 py-2 text-sm flex items-center gap-1.5 border-b-2 -mb-px transition-colors ${
            source === 'youtube'
              ? 'border-primary text-primary font-medium'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          <Music className="h-4 w-4" />
          YouTube
        </button>
      </div>

      {source === 'live' && <LiveBridgeLog />}
      {source === 'doctor' && <DoctorReports />}
      {source === 'youtube' && <YouTubeReports />}
    </div>
  );
}
