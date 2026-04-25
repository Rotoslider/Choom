import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';
import prisma from '@/lib/db';

const QUEUE_DIR = path.resolve(process.cwd(), 'data', 'self_followups');

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

function deriveStatus(e: QueueEntry): FollowupStatus {
  if (e.status) return e.status;
  if (!e.consumed) return 'pending';
  if (e.fired_at) return 'fired';
  return 'cancelled';
}

function readAllQueues(): QueueEntry[] {
  if (!fs.existsSync(QUEUE_DIR)) return [];
  const out: QueueEntry[] = [];
  for (const fname of fs.readdirSync(QUEUE_DIR)) {
    if (!fname.endsWith('.jsonl')) continue;
    const fpath = path.join(QUEUE_DIR, fname);
    try {
      const lines = fs.readFileSync(fpath, 'utf-8').split('\n').filter(Boolean);
      for (const line of lines) {
        try { out.push(JSON.parse(line) as QueueEntry); } catch { /* skip malformed */ }
      }
    } catch { /* skip unreadable */ }
  }
  return out;
}

function writeChoomQueue(choomId: string, entries: QueueEntry[]): void {
  const safe = choomId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const file = path.join(QUEUE_DIR, `${safe}.jsonl`);
  fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
}

export async function GET() {
  try {
    const all = readAllQueues();

    // Enrich with fresh Choom names in case an id no longer maps to a stored name
    const choomIds = [...new Set(all.map(e => e.choom_id))];
    const chooms = choomIds.length > 0
      ? await prisma.choom.findMany({ where: { id: { in: choomIds } }, select: { id: true, name: true } })
      : [];
    const nameById = new Map(chooms.map(c => [c.id, c.name]));

    const enriched = all.map(e => ({
      ...e,
      choom_name: nameById.get(e.choom_id) || e.choom_name,
      status: deriveStatus(e),
    }));

    const pending = enriched
      .filter(e => e.status === 'pending')
      .sort((a, b) => a.trigger_at.localeCompare(b.trigger_at));
    const fired = enriched
      .filter(e => e.status === 'fired')
      .sort((a, b) => (b.fired_at || b.trigger_at).localeCompare(a.fired_at || a.trigger_at));
    const cancelled = enriched
      .filter(e => e.status === 'cancelled' || e.status === 'error')
      .sort((a, b) => (b.cancelled_at || b.trigger_at).localeCompare(a.cancelled_at || a.trigger_at));

    return NextResponse.json({
      pending,
      fired: fired.slice(0, 30),
      cancelled: cancelled.slice(0, 30),
      counts: {
        pending: pending.length,
        fired_recent: Math.min(fired.length, 30),
        cancelled_recent: Math.min(cancelled.length, 30),
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');
    const choomId = searchParams.get('choom_id');
    if (!id || !choomId) {
      return NextResponse.json({ error: 'id and choom_id query params required' }, { status: 400 });
    }

    const safe = choomId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const file = path.join(QUEUE_DIR, `${safe}.jsonl`);
    if (!fs.existsSync(file)) {
      return NextResponse.json({ error: 'No queue for that Choom' }, { status: 404 });
    }

    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    const entries: QueueEntry[] = [];
    for (const line of lines) {
      try { entries.push(JSON.parse(line) as QueueEntry); } catch { /* skip */ }
    }
    const idx = entries.findIndex(e => e.id === id && !e.consumed);
    if (idx === -1) {
      return NextResponse.json({ error: `No pending followup with id "${id}"` }, { status: 404 });
    }
    entries[idx].consumed = true;
    entries[idx].status = 'cancelled';
    entries[idx].cancelled_at = new Date().toISOString();
    writeChoomQueue(choomId, entries);

    return NextResponse.json({ success: true, id });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
