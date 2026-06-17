'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useAppStore } from '@/lib/store';
import { History, RotateCcw, RefreshCw, AlertTriangle, Check } from 'lucide-react';

interface SnapshotInfo {
  id: string;
  takenAt: string;
  label: string;
  source: 'snapshot' | 'daily';
  sizeBytes: number;
}

function prettyTime(iso: string): string {
  if (!iso) return 'unknown time';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

export function BackupSettings() {
  const [snapshots, setSnapshots] = useState<SnapshotInfo[]>([]);
  const [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [confirmDefaults, setConfirmDefaults] = useState(false);
  const applyServerSettings = useAppStore((s) => s.applyServerSettings);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/bridge-config/snapshots');
      const data = await res.json();
      const list: SnapshotInfo[] = data.snapshots || [];
      setSnapshots(list);
      setSelected((cur) => cur || (list[0]?.id ?? ''));
    } catch {
      setMsg({ kind: 'err', text: 'Could not load backups.' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Re-pull the (now restored) server config so the UI reflects it immediately.
  const refreshFromServer = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/defaults');
      if (res.ok) applyServerSettings(await res.json());
    } catch { /* non-critical */ }
  }, [applyServerSettings]);

  const post = useCallback(async (body: Record<string, unknown>) => {
    // Restoring changes server config; off-site the server requires the confirm
    // header. The user clicked an explicit Restore, so we send it.
    return fetch('/api/bridge-config/snapshots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-confirm-remote-write': 'yes' },
      body: JSON.stringify(body),
    });
  }, []);

  const restoreSelected = useCallback(async () => {
    if (!selected) return;
    setBusy(true); setMsg(null);
    try {
      const res = await post({ action: 'restore', id: selected });
      if (!res.ok) throw new Error((await res.json()).error || 'Restore failed');
      await refreshFromServer();
      await load();
      setMsg({ kind: 'ok', text: 'Restored. A current backup was saved first, so this is undoable.' });
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : 'Restore failed' });
    } finally {
      setBusy(false);
    }
  }, [selected, post, refreshFromServer, load]);

  const restoreDefaults = useCallback(async () => {
    setBusy(true); setMsg(null); setConfirmDefaults(false);
    try {
      const res = await post({ action: 'restore-defaults' });
      if (!res.ok) throw new Error((await res.json()).error || 'Reset failed');
      await refreshFromServer();
      await load();
      setMsg({ kind: 'ok', text: 'Reset to defaults. A backup of the previous config was saved first.' });
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : 'Reset failed' });
    } finally {
      setBusy(false);
    }
  }, [post, refreshFromServer, load]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <History className="h-5 w-5" /> Backup &amp; Restore
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Two trails: a <strong>daily</strong> full backup (5am) and a <strong>pre-change</strong>
          snapshot taken right before any settings edit. Roll back to either if
          something gets changed by mistake.
        </p>
      </div>

      {msg && (
        <div className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${
          msg.kind === 'ok'
            ? 'border-green-500/30 bg-green-500/10 text-green-300'
            : 'border-red-500/30 bg-red-500/10 text-red-300'
        }`}>
          {msg.kind === 'ok' ? <Check className="h-4 w-4 mt-0.5" /> : <AlertTriangle className="h-4 w-4 mt-0.5" />}
          <span>{msg.text}</span>
        </div>
      )}

      <div className="rounded-lg border border-border p-4 space-y-3">
        <label className="text-sm font-medium">Restore a previous version</label>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading backups…</p>
        ) : snapshots.length === 0 ? (
          <p className="text-sm text-muted-foreground">No backups yet — one is created the next time settings change.</p>
        ) : (
          <div className="flex flex-col sm:flex-row gap-2">
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
            >
              {snapshots.map((s) => (
                <option key={s.id} value={s.id}>
                  {prettyTime(s.takenAt)} — {s.source === 'daily' ? 'daily backup' : (s.label.replace(/-/g, ' ') || 'pre-change snapshot')}
                </option>
              ))}
            </select>
            <Button onClick={restoreSelected} disabled={busy || !selected} className="gap-2">
              <RotateCcw className="h-4 w-4" /> Restore
            </Button>
          </div>
        )}
        <Button variant="ghost" size="sm" onClick={load} disabled={loading} className="gap-2 text-muted-foreground">
          <RefreshCw className="h-3.5 w-3.5" /> Refresh list
        </Button>
      </div>

      <div className="rounded-lg border border-destructive/30 p-4 space-y-3">
        <label className="text-sm font-medium flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-destructive" /> Reset to defaults
        </label>
        <p className="text-xs text-muted-foreground">
          Resets the server&apos;s settings to factory defaults. A backup is saved first, so you can undo it above.
        </p>
        {confirmDefaults ? (
          <div className="flex items-center gap-2">
            <Button variant="destructive" size="sm" onClick={restoreDefaults} disabled={busy}>
              Yes, reset to defaults
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmDefaults(false)}>Cancel</Button>
          </div>
        ) : (
          <Button variant="outline" size="sm" onClick={() => setConfirmDefaults(true)} disabled={busy}>
            Reset to defaults…
          </Button>
        )}
      </div>
    </div>
  );
}
