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
  const bLlm = (bridge.llm || {}) as Record<string, unknown>;
  const bImage = (bridge.imageGen || {}) as Record<string, unknown>;
  const bWeather = (bridge.weather || {}) as Record<string, unknown>;
  const bSearch = (bridge.search || {}) as Record<string, unknown>;
  const bHa = (bridge.homeAssistant || {}) as Record<string, unknown>;
  const bProviders = Array.isArray(bridge.providers) ? bridge.providers : [];

  // Priority: .env > bridge-config.json > hardcoded. bridge-config.json is the
  // cross-device source of truth (the Settings UI writes to it), so a browser
  // logging in from another machine inherits the SAME values that are actually
  // in effect — not blanks. (Previously most fields read only from .env, so a
  // remote login came up empty for anything configured via the UI.)
  return NextResponse.json({
    llm: {
      endpoint: process.env.LLM_ENDPOINT || (bLlm.endpoint as string) || 'http://localhost:1234/v1',
      model: process.env.LLM_MODEL || (bLlm.model as string) || 'local-model',
    },
    tts: {
      endpoint: process.env.TTS_ENDPOINT || (bTts.endpoint as string) || 'http://localhost:8004',
      defaultVoice: (bTts.defaultVoice as string) || '',
    },
    stt: {
      endpoint: process.env.STT_ENDPOINT || 'http://localhost:5000',
    },
    imageGen: {
      endpoint: process.env.IMAGE_GEN_ENDPOINT || (bImage.endpoint as string) || 'http://localhost:7860',
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
      apiKey: process.env.OPENWEATHER_API_KEY || process.env.OPENWEATHERMAP_API_KEY || (bWeather.apiKey as string) || '',
      location: process.env.DEFAULT_WEATHER_LOCATION || (bWeather.location as string) || '',
      latitude: parseFloat(process.env.DEFAULT_WEATHER_LAT || '') || (bWeather.latitude as number) || 0,
      longitude: parseFloat(process.env.DEFAULT_WEATHER_LON || '') || (bWeather.longitude as number) || 0,
    },
    search: {
      braveApiKey: process.env.BRAVE_API_KEY || (bSearch.braveApiKey as string) || '',
      serpApiKey: process.env.SERPAPI_KEY || (bSearch.serpApiKey as string) || '',
      searxngEndpoint: process.env.SEARXNG_ENDPOINT || (bSearch.searxngEndpoint as string) || '',
    },
    // Home Assistant — was entirely missing here, so remote browsers never
    // inherited the URL/token and would push a blank baseUrl back, breaking HA.
    homeAssistant: {
      baseUrl: process.env.HOME_ASSISTANT_URL || (bHa.baseUrl as string) || '',
      accessToken: process.env.HOME_ASSISTANT_TOKEN || (bHa.accessToken as string) || '',
      entityFilter: (bHa.entityFilter as string) || '',
      cacheSeconds: (bHa.cacheSeconds as number) || 30,
    },
    providers: bProviders,
    ownerName: process.env.OWNER_NAME || (bridge.ownerName as string) || '',
    ownerLocation: process.env.OWNER_LOCATION || (bridge.ownerLocation as string) || '',
  });
}
