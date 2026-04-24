import { NextRequest, NextResponse } from 'next/server';

const DEFAULT_LLM_ENDPOINT = process.env.LLM_ENDPOINT || 'http://localhost:1234/v1';

interface ModelEntry {
  id: string;
  name: string;
  loaded?: boolean;
}

// Derive the LM Studio native REST base (`/api/v0`) from the OpenAI-compat endpoint.
// User-stored endpoint is typically `http://host:1234/v1` — strip `/v1` and append `/api/v0`.
function deriveLmStudioBase(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, '');
  const base = trimmed.endsWith('/v1') ? trimmed.slice(0, -3) : trimmed;
  return `${base}/api/v0`;
}

async function fetchLmStudioLoadedSet(endpoint: string, headers: Record<string, string>): Promise<Set<string> | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${deriveLmStudioBase(endpoint)}/models`, { headers, signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    const loaded = new Set<string>();
    for (const m of data.data || []) {
      if (m && m.state === 'loaded' && typeof m.id === 'string') loaded.add(m.id);
    }
    return loaded;
  } catch {
    return null; // not LM Studio, or unreachable — caller falls back to /v1/models only
  }
}

// GET /api/services/models - Fetch available LLM models
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const endpoint = searchParams.get('endpoint') || DEFAULT_LLM_ENDPOINT;
  const apiKey = searchParams.get('apiKey') || null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const headers: Record<string, string> = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    // Run both requests in parallel — /v1/models for the full catalog, /api/v0/models for loaded state.
    const [response, loadedSet] = await Promise.all([
      fetch(`${endpoint}/models`, { method: 'GET', headers, signal: controller.signal }),
      fetchLmStudioLoadedSet(endpoint, headers),
    ]);

    clearTimeout(timeout);

    if (!response.ok) {
      return NextResponse.json({ error: 'Failed to fetch models' }, { status: response.status });
    }

    const data = await response.json();
    const models: ModelEntry[] = (data.data || []).map((m: { id: string }) => ({
      id: m.id,
      name: m.id,
      ...(loadedSet ? { loaded: loadedSet.has(m.id) } : {}),
    }));

    return NextResponse.json({ models, loadedAvailable: loadedSet !== null });
  } catch (error) {
    console.error('Failed to fetch LLM models:', error);
    return NextResponse.json({ error: 'Service unavailable', models: [] }, { status: 503 });
  }
}
