import { readFile, writeFile, copyFile, mkdir, readdir, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

// Shared helpers for reading/writing services/signal-bridge/bridge-config.json —
// the cross-device source of truth the Settings UI and the Python bridge share.
// Centralized here so the main POST route, the snapshot/restore routes, and the
// local/remote gate all use the same merge + snapshot logic.

export const CONFIG_PATH = path.join(process.cwd(), 'services/signal-bridge/bridge-config.json');
export const SNAPSHOT_DIR = path.join(process.cwd(), 'data/backups/bridge-config');
export const MAX_SNAPSHOTS = 10;

export const DEFAULT_CONFIG = {
  tasks: {
    morning_briefing: { enabled: true, time: '07:00' },
    'weather_check_07:00': { enabled: true, time: '07:00' },
    'weather_check_12:00': { enabled: true, time: '12:00' },
    'weather_check_18:00': { enabled: true, time: '18:00' },
    'aurora_check_12:00': { enabled: true, time: '12:00' },
    'aurora_check_18:00': { enabled: true, time: '18:00' },
    system_health: { enabled: true, interval_minutes: 30 },
    yt_download: { enabled: false, time: '04:00' },
    selfie_backup: { enabled: false, time: '04:00' },
  },
  yt_downloader: {
    max_videos_per_channel: 3,
    channels: [] as { id: string; url: string; name: string; enabled: boolean }[],
  },
  heartbeat: {
    quiet_start: '21:00',
    quiet_end: '06:00',
  },
};

export async function loadConfig(): Promise<Record<string, unknown>> {
  try {
    if (existsSync(CONFIG_PATH)) {
      const data = await readFile(CONFIG_PATH, 'utf-8');
      const loaded = JSON.parse(data);
      return deepMerge(DEFAULT_CONFIG as Record<string, unknown>, loaded as Record<string, unknown>);
    }
    await writeFile(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return DEFAULT_CONFIG;
  } catch {
    return DEFAULT_CONFIG;
  }
}

// Two writers share SNAPSHOT_DIR, with two name forms:
//   this file:          bridge-config_2026-11-05T14-43-30[_label].json  (UTC, from toISOString)
//   the Python bridge:  bridge-config_20261101_205003.json             (the Mac's local time; task_config.py)
// Both used to prune by plain name order, where "20261101" sorts above "2026-11-05", so once the
// bridge had 10 snapshots every one written here was deleted the moment it was made (none kept
// from Nov 1 to Nov 5, 2026). Order by the time a name stands for instead.
const UTC_NAME = /^bridge-config_(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})(?:_(.+))?\.json$/;
const LOCAL_NAME = /^bridge-config_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})(?:_(.+))?\.json$/;

/** When a snapshot was taken (epoch ms) and its label, from its file name; null for other files. */
export function snapshotNameTime(name: string): { ms: number; label: string } | null {
  const u = name.match(UTC_NAME);
  if (u) return { ms: Date.UTC(+u[1], +u[2] - 1, +u[3], +u[4], +u[5], +u[6]), label: u[7] || '' };
  const l = name.match(LOCAL_NAME);
  if (l) return { ms: new Date(+l[1], +l[2] - 1, +l[3], +l[4], +l[5], +l[6]).getTime(), label: l[7] || '' };
  return null;
}

/** Snapshot names, newest first by the time they stand for; names that aren't snapshots are left out. */
export function snapshotsNewestFirst(names: string[]): string[] {
  return names
    .map((n) => ({ n, t: snapshotNameTime(n) }))
    .filter((x): x is { n: string; t: { ms: number; label: string } } => x.t !== null)
    .sort((a, b) => b.t.ms - a.t.ms || b.n.localeCompare(a.n))
    .map((x) => x.n);
}

// "2026-11-05T07:43:30" in the server's local time: what the Restore panel shows.
function localStamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Snapshot bridge-config.json to data/backups/bridge-config/ BEFORE every write,
// keeping the newest MAX_SNAPSHOTS. This is the recovery trail the Restore panel
// exposes. `label` distinguishes a pre-restore snapshot in the filename.
export async function snapshotConfig(label = ''): Promise<void> {
  if (!existsSync(CONFIG_PATH)) return;
  try {
    await mkdir(SNAPSHOT_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const suffix = label ? `_${label}` : '';
    await copyFile(CONFIG_PATH, path.join(SNAPSHOT_DIR, `bridge-config_${ts}${suffix}.json`));
    for (const old of snapshotsNewestFirst(await readdir(SNAPSHOT_DIR)).slice(MAX_SNAPSHOTS)) {
      await unlink(path.join(SNAPSHOT_DIR, old)).catch(() => {});
    }
  } catch (e) {
    console.warn('Failed to snapshot bridge config:', e);
  }
}

// The daily 5am full backup keeps a copy of bridge-config.json per day under
// data/backups/daily/YYYY-MM-DD/. That's the reliable everyday trail (it runs
// regardless of whether settings changed), so the Restore panel surfaces it
// ALONGSIDE the pre-write snapshots.
export const DAILY_DIR = path.join(process.cwd(), 'data/backups/daily');

export interface SnapshotInfo {
  id: string;          // restore handle: a snapshot filename OR "daily/YYYY-MM-DD"
  takenAt: string;     // ISO-ish
  label: string;       // 'pre-restore', 'daily', etc.
  source: 'snapshot' | 'daily';
  sizeBytes: number;
}

export async function listSnapshots(): Promise<SnapshotInfo[]> {
  const { stat } = await import('fs/promises');
  const infos: SnapshotInfo[] = [];

  // Pre-write snapshots (fire only when settings change).
  if (existsSync(SNAPSHOT_DIR)) {
    const files = (await readdir(SNAPSHOT_DIR)).filter((f) => f.startsWith('bridge-config_') && f.endsWith('.json'));
    for (const f of files) {
      // The UTC names used to be shown as if they were local time (7 hours off in Mountain time).
      const t = snapshotNameTime(f);
      const takenAt = t ? localStamp(t.ms) : '';
      const label = t?.label || '';
      let sizeBytes = 0;
      try { sizeBytes = (await stat(path.join(SNAPSHOT_DIR, f))).size; } catch { /* ignore */ }
      infos.push({ id: f, takenAt, label, source: 'snapshot', sizeBytes });
    }
  }

  // Daily full-backup copies of bridge-config.json (one per day).
  if (existsSync(DAILY_DIR)) {
    const days = (await readdir(DAILY_DIR)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
    for (const day of days) {
      const f = path.join(DAILY_DIR, day, 'bridge-config.json');
      if (!existsSync(f)) continue;
      let sizeBytes = 0;
      try { sizeBytes = (await stat(f)).size; } catch { /* ignore */ }
      infos.push({ id: `daily/${day}`, takenAt: `${day}T05:00:00`, label: 'daily', source: 'daily', sizeBytes });
    }
  }

  // newest first, by parsed timestamp
  return infos.sort((a, b) => (b.takenAt || '').localeCompare(a.takenAt || ''));
}

// Resolve a restore handle (a pre-write snapshot filename or "daily/YYYY-MM-DD")
// to an absolute path, guarding against traversal.
function resolveRestoreSource(id: string): string | null {
  const daily = id.match(/^daily\/(\d{4}-\d{2}-\d{2})$/);
  if (daily) return path.join(DAILY_DIR, daily[1], 'bridge-config.json');
  if (/^bridge-config_[\w.\-:]+\.json$/.test(id) && !id.includes('/') && !id.includes('..')) {
    return path.join(SNAPSHOT_DIR, id);
  }
  return null;
}

// Restore a snapshot/daily backup onto bridge-config.json. Snapshots the CURRENT
// config first (labeled 'pre-restore') so a restore is itself undoable.
export async function restoreSnapshot(id: string): Promise<{ ok: boolean; error?: string }> {
  const src = resolveRestoreSource(id);
  if (!src) return { ok: false, error: 'Invalid backup id' };
  if (!existsSync(src)) return { ok: false, error: 'Backup not found' };
  try {
    JSON.parse(await readFile(src, 'utf-8')); // validate before overwriting
    await snapshotConfig('pre-restore');
    await copyFile(src, CONFIG_PATH);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Restore failed' };
  }
}

export function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    const ov = override[key];
    const cur = result[key];

    if (ov === null) {
      // null means "delete this key" — the ONLY way the UI intentionally clears
      // a field (it sends `value || null`, never an empty string). So null is a
      // deliberate clear; '' is just an unset/blank field on the client.
      delete result[key];
    } else if (typeof ov === 'string' && ov === '' && typeof cur === 'string' && cur !== '') {
      // GENERAL GUARD: a blank string from a fresh/partial client (e.g. a phone
      // or off-site browser whose store never had this value) must NEVER clobber
      // a real server value. Intentional clears come through as null above.
      // (preserve cur)
    } else if (Array.isArray(ov) && ov.length === 0 && Array.isArray(cur) && cur.length > 0) {
      // An empty array from a client that hasn't loaded the server's list (e.g.
      // `providers`) must not wipe a populated one.
      // (preserve cur)
    } else if (
      cur && typeof cur === 'object' && !Array.isArray(cur) &&
      ov && typeof ov === 'object' && !Array.isArray(ov)
    ) {
      result[key] = deepMerge(cur as Record<string, unknown>, ov as Record<string, unknown>);
    } else {
      result[key] = ov;
    }
  }
  return result;
}

// Only the NUC itself — reached via localhost — is trusted to change server
// config without confirmation. The NUC IS the server, so it's the one machine
// that should edit freely. Every OTHER device (Mac/phone on the LAN hitting the
// NUC's IP, or off-site via ngrok) must confirm, so they can never break config
// by accident. Decided by the Host header: localhost = the NUC; an IP or a
// hostname = some other device.
export function isLocalRequest(req: Request): boolean {
  const xfHost = req.headers.get('x-forwarded-host') || '';
  const host = (req.headers.get('host') || '').toLowerCase();
  const hostName = (xfHost || host).split(':')[0].toLowerCase();

  const isLoopbackHost = hostName === 'localhost' || hostName === '127.0.0.1' || hostName === '::1';
  if (!isLoopbackHost) return false;

  // A proxy forwarding a non-loopback client onto localhost is NOT really local.
  const xff = req.headers.get('x-forwarded-for') || '';
  const clientIp = xff.split(',')[0].trim().replace(/^::ffff:/, '');
  if (clientIp && clientIp !== '127.0.0.1' && clientIp !== '::1') return false;

  return true;
}
