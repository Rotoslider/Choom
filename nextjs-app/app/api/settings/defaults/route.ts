import { NextResponse } from 'next/server';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * GET /api/settings/defaults
 *
 * Returns the server's configured settings from .env and bridge-config.json.
 * Remote browsers (e.g. via ngrok) use this to bootstrap their localStorage with
 * the correct values instead of localhost defaults that only work on the LAN.
 *
 * Priority: .env values > bridge-config.json values > hardcoded defaults
 */

function loadBridgeConfig(): Record<string, unknown> {
  try {
    const bridgePath = join(process.cwd(), 'services', 'signal-bridge', 'bridge-config.json');
    if (existsSync(bridgePath)) {
      return JSON.parse(readFileSync(bridgePath, 'utf-8'));
    }
  } catch { /* ignore */ }
  return {};
}

export async function GET() {
  const bridge = loadBridgeConfig();
  const bVision = (bridge.vision || {}) as Record<string, unknown>;
  const bTts = (bridge.tts || {}) as Record<string, unknown>;

  return NextResponse.json({
    llm: {
      endpoint: process.env.LLM_ENDPOINT || 'http://localhost:1234/v1',
      model: process.env.LLM_MODEL || 'local-model',
    },
    tts: {
      endpoint: process.env.TTS_ENDPOINT || (bTts.endpoint as string) || 'http://localhost:8004',
      defaultVoice: (bTts.defaultVoice as string) || '',
    },
    stt: {
      endpoint: process.env.STT_ENDPOINT || 'http://localhost:5000',
    },
    imageGen: {
      endpoint: process.env.IMAGE_GEN_ENDPOINT || 'http://localhost:7860',
    },
    memory: {
      endpoint: process.env.MEMORY_ENDPOINT || 'http://localhost:8100',
    },
    vision: {
      endpoint: process.env.VISION_ENDPOINT || (bVision.endpoint as string) || 'http://localhost:1234',
      model: process.env.VISION_MODEL || (bVision.model as string) || '',
      maxTokens: (bVision.maxTokens as number) || 0,
      temperature: (bVision.temperature as number) || 0,
    },
    weather: {
      apiKey: process.env.OPENWEATHER_API_KEY || process.env.OPENWEATHERMAP_API_KEY || '',
      location: process.env.DEFAULT_WEATHER_LOCATION || '',
      latitude: parseFloat(process.env.DEFAULT_WEATHER_LAT || '0') || 0,
      longitude: parseFloat(process.env.DEFAULT_WEATHER_LON || '0') || 0,
    },
    search: {
      braveApiKey: process.env.BRAVE_API_KEY || '',
      serpApiKey: process.env.SERPAPI_KEY || '',
      searxngEndpoint: process.env.SEARXNG_ENDPOINT || '',
    },
    ownerName: process.env.OWNER_NAME || '',
  });
}
