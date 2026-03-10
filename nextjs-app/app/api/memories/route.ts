import { NextRequest, NextResponse } from 'next/server';
import { MemoryClient } from '@/lib/memory-client';
import type { MemoryType } from '@/lib/types';

const DEFAULT_ENDPOINT = process.env.MEMORY_ENDPOINT || 'http://localhost:8100';

function getClient(req: NextRequest): MemoryClient {
  const endpoint = req.headers.get('x-memory-endpoint') || DEFAULT_ENDPOINT;
  return new MemoryClient(endpoint);
}

// GET /api/memories?action=recent|stats&limit=20&companion_id=...
export async function GET(req: NextRequest) {
  try {
    const client = getClient(req);
    const { searchParams } = new URL(req.url);
    const action = searchParams.get('action') || 'recent';
    const limit = parseInt(searchParams.get('limit') || '50');
    const companionId = searchParams.get('companion_id') || undefined;

    let result;
    switch (action) {
      case 'stats':
        result = await client.getStats(companionId);
        break;
      case 'recent':
      default:
        result = await client.getRecent(limit, companionId);
        break;
    }

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { success: false, reason: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

// POST /api/memories — action-based dispatch
export async function POST(req: NextRequest) {
  try {
    const client = getClient(req);
    const body = await req.json();
    const { action, ...params } = body;

    let result;
    switch (action) {
      case 'search':
        result = await client.search(params.query, params.limit || 20, params.companion_id);
        break;
      case 'search_by_type':
        result = await client.searchByType(params.memory_type as MemoryType, params.limit || 20, params.companion_id);
        break;
      case 'search_by_tags':
        result = await client.searchByTags(params.tags, params.limit || 20, params.companion_id);
        break;
      case 'search_by_date_range':
        result = await client.searchByDateRange(params.date_from, params.date_to, params.limit || 50, params.companion_id);
        break;
      case 'remember':
        result = await client.remember(params.title, params.content, {
          tags: params.tags,
          importance: params.importance,
          memory_type: params.memory_type,
          companion_id: params.companion_id,
        });
        break;
      default:
        return NextResponse.json({ success: false, reason: `Unknown action: ${action}` }, { status: 400 });
    }

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { success: false, reason: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

// PUT /api/memories — update a memory
export async function PUT(req: NextRequest) {
  try {
    const client = getClient(req);
    const body = await req.json();
    const { memory_id, ...updates } = body;

    if (!memory_id) {
      return NextResponse.json({ success: false, reason: 'memory_id is required' }, { status: 400 });
    }

    const result = await client.update(memory_id, updates);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { success: false, reason: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

// DELETE /api/memories — delete a memory
export async function DELETE(req: NextRequest) {
  try {
    const client = getClient(req);
    const body = await req.json();
    const { memory_id } = body;

    if (!memory_id) {
      return NextResponse.json({ success: false, reason: 'memory_id is required' }, { status: 400 });
    }

    const result = await client.delete(memory_id);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { success: false, reason: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
