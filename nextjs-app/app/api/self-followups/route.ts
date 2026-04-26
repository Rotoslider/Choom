import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs';
import prisma from '@/lib/db';
import {
  type QueueEntry,
  bucketDir,
  entryPath,
  atomicWriteJson,
  listAllEntries,
  migrateLegacyJsonl,
} from '@/lib/self-followup-store';

function attachStatus(e: QueueEntry, status: 'pending' | 'fired' | 'cancelled' | 'error'): QueueEntry {
  return { ...e, status };
}

export async function GET() {
  try {
    migrateLegacyJsonl();

    const pendingRaw = listAllEntries('pending').map(e => attachStatus(e, 'pending'));
    const firedRaw = listAllEntries('fired').map(e => attachStatus(e, 'fired'));
    const cancelledRaw = [
      ...listAllEntries('cancelled').map(e => attachStatus(e, 'cancelled')),
      ...listAllEntries('error').map(e => attachStatus(e, 'error')),
    ];

    // Refresh choom_name from DB in case an id no longer maps to the stored name.
    const choomIds = [...new Set([...pendingRaw, ...firedRaw, ...cancelledRaw].map(e => e.choom_id))];
    const chooms = choomIds.length > 0
      ? await prisma.choom.findMany({ where: { id: { in: choomIds } }, select: { id: true, name: true } })
      : [];
    const nameById = new Map(chooms.map(c => [c.id, c.name]));
    const enrich = (e: QueueEntry) => ({ ...e, choom_name: nameById.get(e.choom_id) || e.choom_name });

    const pending = pendingRaw.map(enrich).sort((a, b) => a.trigger_at.localeCompare(b.trigger_at));
    const fired = firedRaw.map(enrich).sort((a, b) => (b.fired_at || b.trigger_at).localeCompare(a.fired_at || a.trigger_at));
    const cancelled = cancelledRaw.map(enrich).sort((a, b) => (b.cancelled_at || b.trigger_at).localeCompare(a.cancelled_at || a.trigger_at));

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

    migrateLegacyJsonl();

    const src = entryPath(choomId, 'pending', id);
    const dst = entryPath(choomId, 'cancelled', id);

    if (!fs.existsSync(src)) {
      return NextResponse.json({ error: `No pending followup with id "${id}"` }, { status: 404 });
    }

    // Atomic claim out of pending/ before mutating, so the scheduler can't fire it underneath us.
    try {
      fs.mkdirSync(bucketDir(choomId, 'cancelled'), { recursive: true });
      fs.renameSync(src, dst);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        return NextResponse.json({ error: `Followup "${id}" already fired or was cancelled.` }, { status: 404 });
      }
      throw err;
    }

    try {
      const raw = fs.readFileSync(dst, 'utf-8');
      const entry = JSON.parse(raw) as QueueEntry;
      entry.consumed = true;
      entry.status = 'cancelled';
      entry.cancelled_at = new Date().toISOString();
      atomicWriteJson(dst, entry);
    } catch {
      // metadata update failed but the file is already in cancelled/ — that's still correct status.
    }

    return NextResponse.json({ success: true, id });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
