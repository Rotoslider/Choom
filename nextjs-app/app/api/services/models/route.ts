import { NextRequest, NextResponse } from 'next/server';

const DEFAULT_LLM_ENDPOINT = process.env.LLM_ENDPOINT || 'http://localhost:1234/v1';

// GET /api/services/models - Fetch available LLM models
export async function GET(request: NextRequest) {
  // Get endpoint from query param or use default
  const { searchParams } = new URL(request.url);
  const endpoint = searchParams.get('endpoint') || DEFAULT_LLM_ENDPOINT;
  const apiKey = searchParams.get('apiKey') || null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const headers: Record<string, string> = {};
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const response = await fetch(`${endpoint}/models`, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return NextResponse.json({ error: 'Failed to fetch models' }, { status: response.status });
    }

    const data = await response.json();

    // OpenAI-compatible API returns { data: [...models] }
    const models = data.data?.map((m: { id: string; object?: string }) => ({
      id: m.id,
      name: m.id,
    })) || [];

    return NextResponse.json({ models });
  } catch (error) {
    console.error('Failed to fetch LLM models:', error);
    return NextResponse.json({ error: 'Service unavailable', models: [] }, { status: 503 });
  }
}
