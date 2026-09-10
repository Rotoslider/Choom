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
  // Precedence: bridge-config.json BEFORE the environment.
  //
  // The Settings UI writes bridge-config.json, and store.ts treats the server as
  // the source of truth — but these lines read the env first, so a .env value
  // silently overrode every change made in the UI. Editing an endpoint appeared
  // to work, then reverted on the next load, and the app kept talking to the old
  // host. That cost real debugging time twice.
  //
  // $ENV is now the seed for a fresh install: it supplies the value until
  // something is saved, and stops winning once the user has set one.
  return NextResponse.json({
    local: isLocalRequest(request),
    llm: {
      ...bLlm,
      endpoint: (bLlm.endpoint as string) || process.env.LLM_ENDPOINT || 'http://localhost:1234/v1',
      model: (bLlm.model as string) || process.env.LLM_MODEL || 'local-model',
    },
    tts: {
      ...bTts,
      endpoint: (bTts.endpoint as string) || process.env.TTS_ENDPOINT || 'http://localhost:8004',
    },
    stt: {
      ...bStt,
      endpoint: (bStt.endpoint as string) || process.env.STT_ENDPOINT || 'http://localhost:5000',
    },
    imageGen: {
      ...bImage,
      endpoint: (bImage.endpoint as string) || process.env.IMAGE_GEN_ENDPOINT || 'http://localhost:7860',
    },
    memory: {
      ...bMemory,
      endpoint: (bMemory.endpoint as string) || process.env.MEMORY_ENDPOINT || 'http://localhost:8100',
    },
    vision: {
      ...bVision,
      endpoint: (bVision.endpoint as string) || process.env.VISION_ENDPOINT || 'http://localhost:1234',
      model: (bVision.model as string) || process.env.VISION_MODEL || '',
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
    // TTS servers a Choom can be pinned to (Choom.ttsProviderId). Mirrors
    // `providers` above. When empty the global tts.endpoint is used, which is
    // the behaviour before per-Choom TTS existed.
    ttsProviders: Array.isArray(bridge.ttsProviders) ? bridge.ttsProviders : [],
    visionProfiles: Array.isArray(bridge.visionProfiles) ? bridge.visionProfiles : [],
    modelProfiles: Array.isArray(bridge.modelProfiles) ? bridge.modelProfiles : [],
    ownerName: process.env.OWNER_NAME || (bridge.ownerName as string) || '',
    ownerLocation: process.env.OWNER_LOCATION || (bridge.ownerLocation as string) || '',
  });
}
