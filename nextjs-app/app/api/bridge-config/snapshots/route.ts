import { NextRequest, NextResponse } from 'next/server';
import { writeFile } from 'fs/promises';
import {
  CONFIG_PATH,
  DEFAULT_CONFIG,
  listSnapshots,
  restoreSnapshot,
  snapshotConfig,
  isLocalRequest,
} from '@/lib/bridge-config-store';

// GET /api/bridge-config/snapshots — list the recovery snapshots (newest first)
export async function GET() {
  try {
    return NextResponse.json({ snapshots: await listSnapshots() });
  } catch (error) {
    console.error('Failed to list snapshots:', error);
    return NextResponse.json({ error: 'Failed to list snapshots' }, { status: 500 });
  }
}

// POST /api/bridge-config/snapshots — restore a snapshot or reset to defaults.
// Body: { action: 'restore', file } | { action: 'restore-defaults' }
// Restoring changes server config, so it's gated off-site exactly like a write.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const local = isLocalRequest(request);
    const confirmed = request.headers.get('x-confirm-remote-write') === 'yes';
    if (!local && !confirmed) {
      return NextResponse.json(
        { error: 'remote_write_requires_confirmation', message: 'Confirm to change server settings off-site.' },
        { status: 412 }
      );
    }

    if (body.action === 'restore-defaults') {
      await snapshotConfig('pre-restore');
      await writeFile(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
      return NextResponse.json({ ok: true });
    }

    if (body.action === 'restore' && typeof body.file === 'string') {
      const res = await restoreSnapshot(body.file);
      if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (error) {
    console.error('Failed to restore snapshot:', error);
    return NextResponse.json({ error: 'Failed to restore snapshot' }, { status: 500 });
  }
}
