/**
 * Self-followup queue, file-per-entry layout.
 *
 *   data/self_followups/
 *     {choomIdSafe}/
 *       pending/    sf_xxx.json
 *       fired/      sf_xxx.json
 *       cancelled/  sf_xxx.json
 *       error/      sf_xxx.json
 *
 * The bucket directory is the source of truth for status. State transitions
 * happen via atomic POSIX rename between bucket dirs — no shared file means
 * no read-modify-write race between Node and the Python scheduler.
 */
import * as fs from 'fs';
import * as path from 'path';

export const QUEUE_ROOT = path.resolve(process.cwd(), 'data', 'self_followups');

export type Bucket = 'pending' | 'fired' | 'cancelled' | 'error';
export const BUCKETS: readonly Bucket[] = ['pending', 'fired', 'cancelled', 'error'];

export interface QueueEntry {
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
  status?: Bucket;
}

export function safeChoomId(choomId: string): string {
  return choomId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function choomDir(choomId: string): string {
  return path.join(QUEUE_ROOT, safeChoomId(choomId));
}

export function bucketDir(choomId: string, bucket: Bucket): string {
  return path.join(choomDir(choomId), bucket);
}

export function entryPath(choomId: string, bucket: Bucket, id: string): string {
  return path.join(bucketDir(choomId, bucket), `${id}.json`);
}

export function atomicWriteJson(target: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, target);
}

export function atomicMove(src: string, dst: string): void {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.renameSync(src, dst);
}

function readEntry(fpath: string): QueueEntry | null {
  try {
    return JSON.parse(fs.readFileSync(fpath, 'utf-8')) as QueueEntry;
  } catch {
    return null;
  }
}

/** List entries in a single bucket for a single Choom. */
export function listEntries(choomId: string, bucket: Bucket): QueueEntry[] {
  const dir = bucketDir(choomId, bucket);
  if (!fs.existsSync(dir)) return [];
  const out: QueueEntry[] = [];
  for (const fname of fs.readdirSync(dir)) {
    if (!fname.endsWith('.json')) continue;
    const e = readEntry(path.join(dir, fname));
    if (e) out.push(e);
  }
  return out;
}

/** List entries in one bucket across every Choom. Used by the settings API. */
export function listAllEntries(bucket: Bucket): QueueEntry[] {
  if (!fs.existsSync(QUEUE_ROOT)) return [];
  const out: QueueEntry[] = [];
  for (const choomSafe of fs.readdirSync(QUEUE_ROOT)) {
    const choomBucketDir = path.join(QUEUE_ROOT, choomSafe, bucket);
    if (!fs.existsSync(choomBucketDir)) continue;
    let stat: fs.Stats;
    try { stat = fs.statSync(choomBucketDir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    for (const fname of fs.readdirSync(choomBucketDir)) {
      if (!fname.endsWith('.json')) continue;
      const e = readEntry(path.join(choomBucketDir, fname));
      if (e) out.push(e);
    }
  }
  return out;
}

function bucketFromLegacyEntry(e: QueueEntry): Bucket {
  if (e.status === 'fired' || e.fired_at) return 'fired';
  if (e.status === 'cancelled' || e.cancelled_at) return 'cancelled';
  if (e.status === 'error') return 'error';
  if (e.consumed) return 'cancelled';
  return 'pending';
}

/**
 * One-shot migration of legacy `data/self_followups/{choomId}.jsonl` files
 * into the per-entry layout. Idempotent and crash-safe — if the same legacy
 * file is migrated twice (e.g. by both Node and Python), the second pass is
 * a no-op because `existsSync(target)` short-circuits and the rename to
 * `.migrated-*` is best-effort.
 */
export function migrateLegacyJsonl(): void {
  if (!fs.existsSync(QUEUE_ROOT)) return;
  for (const fname of fs.readdirSync(QUEUE_ROOT)) {
    if (!fname.endsWith('.jsonl')) continue;
    const fpath = path.join(QUEUE_ROOT, fname);
    let stat: fs.Stats;
    try { stat = fs.statSync(fpath); } catch { continue; }
    if (!stat.isFile()) continue;

    const safe = fname.slice(0, -'.jsonl'.length);
    let lines: string[] = [];
    try {
      lines = fs.readFileSync(fpath, 'utf-8').split('\n').filter(Boolean);
    } catch {
      continue;
    }
    let migrated = 0;
    for (const line of lines) {
      let entry: QueueEntry;
      try { entry = JSON.parse(line) as QueueEntry; } catch { continue; }
      if (!entry?.id) continue;
      const bucket = bucketFromLegacyEntry(entry);
      const target = path.join(QUEUE_ROOT, safe, bucket, `${entry.id}.json`);
      if (fs.existsSync(target)) continue;
      try {
        atomicWriteJson(target, entry);
        migrated++;
      } catch {
        // ignore — next pass will retry
      }
    }
    try {
      fs.renameSync(fpath, `${fpath}.migrated-${Date.now()}`);
      console.log(`   📦 self-followups: migrated ${migrated} entries from ${fname}`);
    } catch {
      // already renamed by another process
    }
  }
}
