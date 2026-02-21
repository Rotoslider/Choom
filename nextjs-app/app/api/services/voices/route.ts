import { NextRequest, NextResponse } from 'next/server';

const DEFAULT_TTS_ENDPOINT = process.env.TTS_ENDPOINT || 'http://localhost:8004';

// Voice endpoint paths to try in order
const VOICE_PATHS = ['/v1/voices', '/voices', '/api/voices'];

// GET /api/services/voices - Fetch available TTS voices
export async function GET(request: NextRequest) {
  // Get endpoint from query param or use default
  const { searchParams } = new URL(request.url);
  const endpoint = searchParams.get('endpoint') || DEFAULT_TTS_ENDPOINT;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    // Try each voice endpoint path
    for (const voicePath of VOICE_PATHS) {
      try {
        const response = await fetch(`${endpoint}${voicePath}`, {
          method: 'GET',
          signal: controller.signal,
        });

        if (response.ok) {
          clearTimeout(timeout);
          const data = await response.json();
          return NextResponse.json({ voices: normalizeVoices(data) });
        }
      } catch {
        // Try next path
        continue;
      }
    }

    clearTimeout(timeout);
    return NextResponse.json({ error: 'Failed to fetch voices', voices: [] }, { status: 503 });
  } catch (error) {
    console.error('Failed to fetch TTS voices:', error);
    return NextResponse.json({ error: 'Service unavailable', voices: [] }, { status: 503 });
  }
}

function normalizeVoices(data: unknown): { id: string; name: string }[] {
  // Handle different TTS API response formats
  if (Array.isArray(data)) {
    return data.map((v: string | { id: string; name?: string }) => {
      if (typeof v === 'string') {
        return { id: v, name: v };
      }
      return { id: v.id, name: v.name || v.id };
    });
  }

  if (data && typeof data === 'object' && 'voices' in data) {
    return normalizeVoices((data as { voices: unknown }).voices);
  }

  return [];
}
