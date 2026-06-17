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
    const files = (await readdir(SNAPSHOT_DIR))
      .filter((f) => f.startsWith('bridge-config_'))
      .sort()
      .reverse();
    for (const old of files.slice(MAX_SNAPSHOTS)) {
      await unlink(path.join(SNAPSHOT_DIR, old)).catch(() => {});
    }
  } catch (e) {
    console.warn('Failed to snapshot bridge config:', e);
  }
}

export interface SnapshotInfo {
  file: string;
  takenAt: string; // ISO
  label: string;
  sizeBytes: number;
}

export async function listSnapshots(): Promise<SnapshotInfo[]> {
  if (!existsSync(SNAPSHOT_DIR)) return [];
  const { stat } = await import('fs/promises');
  const files = (await readdir(SNAPSHOT_DIR)).filter((f) => f.startsWith('bridge-config_') && f.endsWith('.json'));
  const infos: SnapshotInfo[] = [];
  for (const f of files) {
    let takenAt = '';
    let label = '';
    // New format: bridge-config_2026-06-16T22-32-56[_label].json
    const m = f.match(/^bridge-config_(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:_(.+))?\.json$/);
    // Old format: bridge-config_20260614_154635.json
    const o = f.match(/^bridge-config_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.json$/);
    if (m) {
      takenAt = `${m[1]}T${m[2]}:${m[3]}:${m[4]}`;
      label = m[5] || '';
    } else if (o) {
      takenAt = `${o[1]}-${o[2]}-${o[3]}T${o[4]}:${o[5]}:${o[6]}`;
    }
    let sizeBytes = 0;
    try { sizeBytes = (await stat(path.join(SNAPSHOT_DIR, f))).size; } catch { /* ignore */ }
    infos.push({ file: f, takenAt, label, sizeBytes });
  }
  // newest first, by parsed timestamp (filename formats differ across versions)
  return infos.sort((a, b) => (b.takenAt || '').localeCompare(a.takenAt || ''));
}

// Restore a snapshot file onto bridge-config.json. Snapshots the CURRENT config
// first (labeled 'pre-restore') so a restore is itself undoable.
export async function restoreSnapshot(file: string): Promise<{ ok: boolean; error?: string }> {
  // Guard against path traversal — only a plain snapshot filename is allowed.
  if (!/^bridge-config_[\w.\-:]+\.json$/.test(file) || file.includes('/') || file.includes('..')) {
    return { ok: false, error: 'Invalid snapshot filename' };
  }
  const src = path.join(SNAPSHOT_DIR, file);
  if (!existsSync(src)) return { ok: false, error: 'Snapshot not found' };
  try {
    // Validate it parses before we overwrite anything.
    JSON.parse(await readFile(src, 'utf-8'));
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

// Decide whether a request originates from the home machine/LAN (trusted) or
// from off-site (e.g. ngrok) where settings writes must be confirmed. We trust:
// localhost, and RFC-1918 private ranges. Anything else (an ngrok hostname or a
// public client IP) is treated as remote.
export function isLocalRequest(req: Request): boolean {
  // Forwarded-* headers are set by ngrok/proxies for off-site clients. Their
  // presence with a non-private client IP is the strongest "remote" signal.
  const xfHost = req.headers.get('x-forwarded-host') || '';
  const host = (req.headers.get('host') || '').toLowerCase();
  const hostName = (xfHost || host).split(':')[0].toLowerCase();

  // ngrok / public hostname → remote
  if (hostName && !isLocalHostname(hostName)) return false;

  // If a forwarded-for chain exists, the left-most entry is the real client.
  const xff = req.headers.get('x-forwarded-for') || '';
  const clientIp = xff.split(',')[0].trim();
  if (clientIp && !isPrivateIp(clientIp)) return false;

  return true;
}

function isLocalHostname(h: string): boolean {
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.local')) return true;
  return isPrivateIp(h);
}

function isPrivateIp(ip: string): boolean {
  // strip IPv6-mapped prefix
  const v = ip.replace(/^::ffff:/, '');
  if (v === '127.0.0.1' || v === '::1' || v === 'localhost') return true;
  if (/^10\./.test(v)) return true;
  if (/^192\.168\./.test(v)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(v)) return true;
  return false;
}
