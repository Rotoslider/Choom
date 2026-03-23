import { NextRequest, NextResponse } from 'next/server';

const DEFAULT_MEMORY_ENDPOINT = process.env.MEMORY_ENDPOINT || 'http://localhost:8100';

/**
 * Proxy for memory server operations.
 * The browser may not be able to reach the memory server directly (e.g. via ngrok),
 * so we proxy through the Next.js backend which is on the same LAN.
 */

// GET /api/services/memory?action=stats&endpoint=...
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || 'stats';
  const endpoint = searchParams.get('endpoint') || DEFAULT_MEMORY_ENDPOINT;

  try {
    let path: string;
    switch (action) {
      case 'stats':
        path = '/memory/stats';
        break;
      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }

    const response = await fetch(`${endpoint}${path}`, {
      signal: AbortSignal.timeout(5000),
    });

    if (response.ok) {
      const data = await response.json();
      return NextResponse.json(data);
    }
    return NextResponse.json(
      { error: `Memory server returned ${response.status}` },
      { status: response.status }
    );
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to reach memory server: ' + (error as Error).message },
      { status: 502 }
    );
  }
}

// POST /api/services/memory?action=backup|rebuild_vectors&endpoint=...
export async function POST(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action');
  const endpoint = searchParams.get('endpoint') || DEFAULT_MEMORY_ENDPOINT;

  try {
    let path: string;
    switch (action) {
      case 'backup':
        path = '/memory/backup';
        break;
      case 'rebuild_vectors':
        path = '/memory/rebuild_vectors';
        break;
      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }

    const response = await fetch(`${endpoint}${path}`, {
      method: 'POST',
      signal: AbortSignal.timeout(30000),
    });

    if (response.ok) {
      const data = await response.json();
      return NextResponse.json(data);
    }
    return NextResponse.json(
      { error: `Memory server returned ${response.status}` },
      { status: response.status }
    );
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to reach memory server: ' + (error as Error).message },
      { status: 502 }
    );
  }
}
