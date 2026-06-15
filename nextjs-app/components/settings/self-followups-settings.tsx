'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Clock, Trash2, CheckCircle2, RefreshCw, XCircle, Pencil, Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

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
  target?: 'signal' | 'room';
  room_id?: string;
}

interface EditState {
  trigger_at: string;
  prompt: string;
}

export function SelfFollowupsSettings() {
  const [pending, setPending] = useState<QueueEntry[]>([]);
  const [fired, setFired] = useState<QueueEntry[]>([]);
  const [cancelled, setCancelled] = useState<QueueEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editState, setEditState] = useState<EditState>({ trigger_at: '', prompt: '' });
  const [saving, setSaving] = useState(false);

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

  const startEditing = (entry: QueueEntry) => {
    const localDt = toLocalDatetimeValue(entry.trigger_at);
    setEditingId(entry.id);
    setEditState({ trigger_at: localDt, prompt: entry.prompt });
  };

  const cancelEditing = () => {
    setEditingId(null);
  };

  const saveEdit = async (entry: QueueEntry) => {
    setSaving(true);
    try {
      const newTriggerAt = new Date(editState.trigger_at).toISOString();
      const res = await fetch('/api/self-followups', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: entry.id,
          choom_id: entry.choom_id,
          trigger_at: newTriggerAt,
          prompt: editState.prompt,
        }),
      });
      if (res.ok) {
        setPending((prev) =>
          prev.map((e) =>
            e.id === entry.id
              ? { ...e, trigger_at: newTriggerAt, prompt: editState.prompt }
              : e
          )
        );
        setEditingId(null);
      }
    } catch (err) {
      console.error('Failed to save followup:', err);
    } finally {
      setSaving(false);
    }
  };

  const toLocalDatetimeValue = (iso: string) => {
    try {
      const d = new Date(iso);
      const offset = d.getTimezoneOffset();
      const local = new Date(d.getTime() - offset * 60000);
      return local.toISOString().slice(0, 16);
    } catch {
      return '';
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
      // eslint-disable-next-line react-hooks/purity -- relative-time label is meant to reflect the current time at render
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
                className={`flex items-start gap-3 p-3 border rounded-lg bg-card${e.target === 'room' ? ' border-l-4 border-l-violet-500' : ''}`}
              >
                <div className="flex-1 min-w-0">
                  {editingId === e.id ? (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium">{e.choom_name}</span>
                        <Input
                          type="datetime-local"
                          value={editState.trigger_at}
                          onChange={(ev) =>
                            setEditState((s) => ({ ...s, trigger_at: ev.target.value }))
                          }
                          className="h-7 text-xs w-auto"
                        />
                      </div>
                      <textarea
                        value={editState.prompt}
                        onChange={(ev) =>
                          setEditState((s) => ({ ...s, prompt: ev.target.value }))
                        }
                        className="w-full text-sm p-2 border rounded bg-background resize-y min-h-[60px]"
                        rows={2}
                      />
                      {e.reason ? (
                        <p className="text-xs text-muted-foreground italic">
                          reason: {e.reason}
                        </p>
                      ) : null}
                      <p className="text-xs text-muted-foreground font-mono">
                        id: {e.id}
                      </p>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium">{e.choom_name}</span>
                        {e.target === 'room' ? (
                          <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-400 font-medium">
                            Room
                          </span>
                        ) : null}
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
                    </>
                  )}
                </div>
                <div className="flex flex-col gap-1">
                  {editingId === e.id ? (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => saveEdit(e)}
                        disabled={saving}
                        title="Save changes"
                      >
                        <Check className="h-4 w-4 text-green-500" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={cancelEditing}
                        title="Discard changes"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => startEditing(e)}
                        title="Edit time & prompt"
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => cancelFollowup(e)}
                        title="Cancel this followup"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </>
                  )}
                </div>
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
