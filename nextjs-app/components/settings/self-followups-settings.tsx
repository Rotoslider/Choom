'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Clock, Trash2, CheckCircle2, RefreshCw, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

type FollowupStatus = 'pending' | 'fired' | 'cancelled' | 'error';

interface QueueEntry {
  id: string;
  choom_id: string;
  choom_name: string;
  prompt: string;
  reason: string;
  trigger_at: string;
  created_at: string;
  consumed: boolean;
  fired_at?: string;
  cancelled_at?: string;
  status?: FollowupStatus;
}

export function SelfFollowupsSettings() {
  const [pending, setPending] = useState<QueueEntry[]>([]);
  const [fired, setFired] = useState<QueueEntry[]>([]);
  const [cancelled, setCancelled] = useState<QueueEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchFollowups = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const res = await fetch('/api/self-followups', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setPending(data.pending || []);
        setFired(data.fired || []);
        setCancelled(data.cancelled || []);
      }
    } catch (err) {
      console.error('Failed to fetch followups:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchFollowups();
    const interval = setInterval(() => fetchFollowups(true), 30_000);
    return () => clearInterval(interval);
  }, [fetchFollowups]);

  const cancelFollowup = async (entry: QueueEntry) => {
    const params = new URLSearchParams({ id: entry.id, choom_id: entry.choom_id });
    try {
      const res = await fetch(`/api/self-followups?${params}`, { method: 'DELETE' });
      if (res.ok) {
        setPending((prev) => prev.filter((e) => e.id !== entry.id));
      }
    } catch (err) {
      console.error('Failed to cancel followup:', err);
    }
  };

  const formatTime = (iso: string) => {
    try {
      return new Date(iso).toLocaleString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
    } catch {
      return iso;
    }
  };

  const timeUntil = (iso: string) => {
    try {
      const diffMs = new Date(iso).getTime() - Date.now();
      if (diffMs < 0) return 'overdue';
      const mins = Math.round(diffMs / 60000);
      if (mins < 60) return `in ${mins} min`;
      const hrs = Math.round(mins / 60);
      if (hrs < 48) return `in ${hrs} hr${hrs === 1 ? '' : 's'}`;
      const days = Math.round(hrs / 24);
      return `in ${days} day${days === 1 ? '' : 's'}`;
    } catch {
      return '';
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-lg font-medium flex items-center gap-2">
            <Clock className="h-5 w-5" />
            Self-Scheduled Followups
          </h3>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => fetchFollowups()}
            disabled={refreshing}
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Ticks the Chooms have queued for themselves via <code>schedule_self_followup</code>. They fire as one-shot heartbeats at the scheduled time.
        </p>
      </div>

      <section>
        <h4 className="text-sm font-medium mb-2 text-muted-foreground">
          Pending ({pending.length})
        </h4>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : pending.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">No pending followups.</p>
        ) : (
          <ul className="space-y-2">
            {pending.map((e) => (
              <li
                key={e.id}
                className="flex items-start gap-3 p-3 border rounded-lg bg-card"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium">{e.choom_name}</span>
                    <span className="text-xs text-muted-foreground">
                      {formatTime(e.trigger_at)} ({timeUntil(e.trigger_at)})
                    </span>
                  </div>
                  <p className="text-sm mt-1 break-words">{e.prompt}</p>
                  {e.reason ? (
                    <p className="text-xs text-muted-foreground mt-1 italic">
                      reason: {e.reason}
                    </p>
                  ) : null}
                  <p className="text-xs text-muted-foreground mt-1 font-mono">
                    id: {e.id}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => cancelFollowup(e)}
                  title="Cancel this followup"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h4 className="text-sm font-medium mb-2 text-muted-foreground flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4" />
          Recently Fired ({fired.length})
        </h4>
        {fired.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">Nothing fired yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {fired.map((e) => (
              <li
                key={e.id}
                className="text-xs p-2 border rounded bg-muted/30"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium">{e.choom_name}</span>
                  <span className="text-muted-foreground">
                    fired {formatTime(e.fired_at || e.trigger_at)}
                  </span>
                </div>
                <p className="mt-0.5 text-muted-foreground break-words line-clamp-2">
                  {e.prompt}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h4 className="text-sm font-medium mb-2 text-muted-foreground flex items-center gap-2">
          <XCircle className="h-4 w-4" />
          Recently Cancelled ({cancelled.length})
        </h4>
        {cancelled.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">Nothing cancelled.</p>
        ) : (
          <ul className="space-y-1.5">
            {cancelled.map((e) => (
              <li
                key={e.id}
                className="text-xs p-2 border rounded bg-muted/30"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium">{e.choom_name}</span>
                  <span className="text-muted-foreground">
                    {e.status === 'error' ? 'errored' : 'cancelled'}
                    {e.cancelled_at ? ` ${formatTime(e.cancelled_at)}` : ''}
                    {' · was scheduled for '}
                    {formatTime(e.trigger_at)}
                  </span>
                </div>
                <p className="mt-0.5 text-muted-foreground break-words line-clamp-2">
                  {e.prompt}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
