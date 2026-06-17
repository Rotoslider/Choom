import { NextResponse } from 'next/server';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { isLocalRequest } from '@/lib/bridge-config-store';

/**
 * GET /api/settings/defaults
 *
 * Returns the server's EFFECTIVE config (whole server-owned slices from
 * bridge-config.json, with .env taking priority) plus a `local` flag.
 *
 * The client treats the server as the source of truth: on load it OVERWRITES its
 * own server-owned settings with these (preserving per-device cosmetics). So a
 * stale/blank/off-site browser is corrected to the server every load and can
 * never silently win. Priority: .env > bridge-config.json > hardcoded.
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

export async function GET(request: Request) {
  const bridge = loadBridgeConfig();
  const obj = (k: string) => (bridge[k] || {}) as Record<string, unknown>;
  const bVision = obj('vision');
  const bTts = obj('tts');
  const bStt = obj('stt');
  const bLlm = obj('llm');
  const bImage = obj('imageGen');
  const bMemory = obj('memory');
  const bWeather = obj('weather');
  const bSearch = obj('search');
  const bHa = obj('homeAssistant');

  // Whole slices so the client can overwrite server-owned settings wholesale.
  // .env wins for the few fields it can set; otherwise the bridge value (what
  // the UI last saved) is the truth.
  return NextResponse.json({
    local: isLocalRequest(request),
    llm: {
      ...bLlm,
      endpoint: process.env.LLM_ENDPOINT || (bLlm.endpoint as string) || 'http://localhost:1234/v1',
      model: process.env.LLM_MODEL || (bLlm.model as string) || 'local-model',
    },
    tts: {
      ...bTts,
      endpoint: process.env.TTS_ENDPOINT || (bTts.endpoint as string) || 'http://localhost:8004',
    },
    stt: {
      ...bStt,
      endpoint: process.env.STT_ENDPOINT || (bStt.endpoint as string) || 'http://localhost:5000',
    },
    imageGen: {
      ...bImage,
      endpoint: process.env.IMAGE_GEN_ENDPOINT || (bImage.endpoint as string) || 'http://localhost:7860',
    },
    memory: {
      ...bMemory,
      endpoint: process.env.MEMORY_ENDPOINT || (bMemory.endpoint as string) || 'http://localhost:8100',
    },
    vision: {
      ...bVision,
      endpoint: process.env.VISION_ENDPOINT || (bVision.endpoint as string) || 'http://localhost:1234',
      model: process.env.VISION_MODEL || (bVision.model as string) || '',
    },
    weather: {
      ...bWeather,
      apiKey: process.env.OPENWEATHER_API_KEY || process.env.OPENWEATHERMAP_API_KEY || (bWeather.apiKey as string) || '',
    },
    search: {
      ...bSearch,
      braveApiKey: process.env.BRAVE_API_KEY || (bSearch.braveApiKey as string) || '',
      serpApiKey: process.env.SERPAPI_KEY || (bSearch.serpApiKey as string) || '',
    },
    homeAssistant: {
      ...bHa,
      baseUrl: process.env.HOME_ASSISTANT_URL || (bHa.baseUrl as string) || '',
      accessToken: process.env.HOME_ASSISTANT_TOKEN || (bHa.accessToken as string) || '',
    },
    providers: Array.isArray(bridge.providers) ? bridge.providers : [],
    visionProfiles: Array.isArray(bridge.visionProfiles) ? bridge.visionProfiles : [],
    modelProfiles: Array.isArray(bridge.modelProfiles) ? bridge.modelProfiles : [],
    ownerName: process.env.OWNER_NAME || (bridge.ownerName as string) || '',
    ownerLocation: process.env.OWNER_LOCATION || (bridge.ownerLocation as string) || '',
  });
}
