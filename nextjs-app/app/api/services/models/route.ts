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

// GET /api/services/models?endpoint=… - model list for an endpoint that needs no key.
// Keys never go in the URL: next dev writes every request URL to data/logs/choom-dev.log.
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  return listModels(searchParams.get('endpoint') || DEFAULT_LLM_ENDPOINT, null);
}

// POST /api/services/models {endpoint, apiKey?} - the settings model menus (lib/model-list-request.ts).
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const endpoint = typeof body.endpoint === 'string' && body.endpoint ? body.endpoint : DEFAULT_LLM_ENDPOINT;
  const apiKey = typeof body.apiKey === 'string' && body.apiKey ? body.apiKey : null;
  return listModels(endpoint, apiKey);
}

async function listModels(endpoint: string, apiKey: string | null) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const headers: Record<string, string> = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    // Anthropic's own API lists its models at /v1/models and takes x-api-key, not a Bearer token
    if (/^https?:\/\/api\.anthropic\.com(\/|$)/.test(endpoint)) {
      const res = await fetch(`${endpoint.replace(/\/+$/, '')}/v1/models?limit=100`, {
        headers: { 'x-api-key': apiKey || '', 'anthropic-version': '2023-06-01' },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) {
        return NextResponse.json({ error: 'Failed to fetch models' }, { status: res.status });
      }
      const data = await res.json();
      const models: ModelEntry[] = (data.data || []).map((m: { id: string }) => ({ id: m.id, name: m.id }));
      return NextResponse.json({ models, loadedAvailable: false });
    }

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
    // One line, not a stack: an unreachable LM Studio (NUC asleep/restarting)
    // is routine — only the settings/edit-panel model dropdowns call this.
    const cause = (error as { cause?: { code?: string } })?.cause?.code;
    const reason = cause || (error instanceof Error ? (error.name === 'AbortError' ? 'timed out' : error.message) : String(error));
    console.warn(`⚠️ LLM server unreachable at ${endpoint} (model list for settings UI): ${reason}`);
    return NextResponse.json({ error: 'Service unavailable', models: [] }, { status: 503 });
  }
}
