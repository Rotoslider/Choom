import { NextRequest, NextResponse } from 'next/server';
import { writeFile } from 'fs/promises';
import {
  CONFIG_PATH,
  loadConfig,
  snapshotConfig,
  deepMerge,
  isLocalRequest,
} from '@/lib/bridge-config-store';

// GET /api/bridge-config - Read bridge config
export async function GET() {
  try {
    const config = await loadConfig();
    return NextResponse.json(config);
  } catch (error) {
    console.error('Failed to read bridge config:', error);
    return NextResponse.json(
      { error: 'Failed to read bridge config' },
      { status: 500 }
    );
  }
}

// POST /api/bridge-config - Update bridge config
//
// Server is the source of truth. A write from OFF-SITE (e.g. ngrok) must be
// explicitly confirmed by the user — the client resends with the
// `x-confirm-remote-write` header after an "Are you sure?" dialog. Without it we
// reject remote writes (HTTP 412) so a stale/blank off-site browser can never
// silently change server config. Local/LAN writes are trusted.
export async function POST(request: NextRequest) {
  try {
    const updates = await request.json();

    const local = isLocalRequest(request);
    const confirmed = request.headers.get('x-confirm-remote-write') === 'yes';
    if (!local && !confirmed) {
      return NextResponse.json(
        {
          error: 'remote_write_requires_confirmation',
          message: 'You are connected off-site. Confirm to change server settings.',
        },
        { status: 412 }
      );
    }

    const current = await loadConfig();
    await snapshotConfig();

    const merged = deepMerge(current, updates);
    await writeFile(CONFIG_PATH, JSON.stringify(merged, null, 2));

    return NextResponse.json(merged);
  } catch (error) {
    console.error('Failed to update bridge config:', error);
    return NextResponse.json(
      { error: 'Failed to update bridge config' },
      { status: 500 }
    );
  }
}
