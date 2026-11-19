import { NextRequest, NextResponse } from 'next/server';
import { loadConfig } from '@/lib/bridge-config-store';
import { h3Health } from '@/lib/h3-image-client';
import prisma from '@/lib/db';
import type { ImageEngine, ImageGenSettings } from '@/lib/types';

interface HealthResult {
  service: string;
  status: 'connected' | 'disconnected';
  latency?: number;
  error?: string;
  details?: Record<string, unknown>;
}

async function checkService(
  name: string,
  endpoint: string,
  healthPaths: string[]
): Promise<HealthResult> {
  const startTime = Date.now();

  // Try each health path until one succeeds
  for (const healthPath of healthPaths) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {

      const url = `${endpoint}${healthPath}`;
      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'Accept': 'application/json',
        },
      });
      const latency = Date.now() - startTime;

      // 405 Method Not Allowed means server is up (endpoint exists but needs POST)
      if (response.ok || response.status === 405) {
        let details: Record<string, unknown> = {};
        if (response.ok) {
          try {
            const text = await response.text();
            if (text) {
              details = JSON.parse(text);
            }
          } catch {
            // Ignore JSON parse errors - some endpoints return non-JSON
          }
        }

        return {
          service: name,
          status: 'connected',
          latency,
          details,
        };
      }

      // If we got a response but not OK, continue trying other paths
    } catch {
      // If aborted or network error, continue trying other paths
      continue;
    } finally {
      clearTimeout(timeout);  // a failed path used to leave its 5 s timer running
    }
  }

  // All paths failed
  return {
    service: name,
    status: 'disconnected',
    error: 'Connection failed - service may be offline',
  };
}

// Check cloud API services by verifying API key is configured
// (don't make real API calls — they're slow, rate-limited, and waste quota)
function checkApiKeyConfigured(
  name: string,
  provider: string,
  apiKey: string,
): HealthResult {
  if (!apiKey) {
    return {
      service: name,
      status: 'disconnected',
      error: `No API key configured for ${provider}`,
    };
  }
  return {
    service: name,
    status: 'connected',
    details: { provider },
  };
}

// Health check paths for each service (in order of preference)
const healthPaths: Record<string, string[]> = {
  llm: ['/models', '/v1/models', '/'],
  memory: ['/memory/stats', '/', '/health'],
  tts: ['/v1/voices', '/voices', '/', '/health'],
  stt: ['/health', '/', '/v1/audio/transcriptions'],
  imageGen: ['/sdapi/v1/options', '/sdapi/v1/sd-models', '/'],
  searxng: ['/', '/healthz', '/search?q=test&format=json'],
};

// Default endpoints from environment
const defaultEndpoints = {
  llm: process.env.LLM_ENDPOINT || 'http://localhost:1234/v1',
  memory: process.env.MEMORY_ENDPOINT || 'http://localhost:8100',
  tts: process.env.TTS_ENDPOINT || 'http://localhost:8004',
  stt: process.env.STT_ENDPOINT || 'http://localhost:5000',
  imageGen: process.env.IMAGE_GEN_ENDPOINT || 'http://localhost:7860',
  searxng: process.env.SEARXNG_ENDPOINT || 'http://localhost:8888',
};

// Image Gen checks the engine the Chooms make their pictures with, not always Forge. Donny, Nov 19:
// they use MiniMax H3 Image now, and a check of Forge said nothing about whether their pictures work.
// The engine is Settings > Image as the server has it (bridge-config.json: a browser's own settings can
// be from before a switch), plus any Choom's own choice over it (Choom settings > Images), so a Choom
// still on Forge keeps Forge checked too.
async function imageEnginesInUse(): Promise<{ imageGen: Partial<ImageGenSettings>; engines: ImageEngine[] }> {
  const config = (await loadConfig().catch(() => ({}))) as Record<string, unknown>;
  const imageGen = (config.imageGen || {}) as Partial<ImageGenSettings>;
  const engines = new Set<ImageEngine>([imageGen.engine === 'h3image' ? 'h3image' : 'forge']);
  try {
    for (const c of await prisma.choom.findMany({ select: { imageSettings: true } })) {
      let own: unknown;
      try { own = c.imageSettings ? (JSON.parse(c.imageSettings) as { engine?: unknown }).engine : undefined; } catch { /* not JSON */ }
      if (own === 'forge' || own === 'h3image') engines.add(own);
    }
  } catch {
    // Settings' engine alone
  }
  return { imageGen, engines: [...engines] };
}

// The H3 Image server (studio/h3image_server.py on the NUC) answers /health with its model's state.
// Ready means it can draw now; "released" means it stepped aside for a Glass Studio render and takes
// the GPU back for a picture. "off" means its model isn't loaded: a failed load, or switched off.
const H3_STATES: Record<string, string> = {
  ready: 'ready',
  busy: 'ready, drawing a picture',
  loading: 'loading its model',
  released: 'ready, stepped aside for a Glass Studio render',
};
async function checkH3Image(imageGen: Partial<ImageGenSettings>): Promise<HealthResult> {
  const started = Date.now();
  const h = await h3Health(imageGen);
  const latency = Date.now() - started;
  const details = { engine: 'h3image', provider: 'MiniMax H3 Image', endpoint: h.endpoint, state: h.state, queued: h.queued };
  if (!h.ok) {
    return { service: 'imageGen', status: 'disconnected', error: h.error || `H3 Image isn't answering at ${h.endpoint}`, details };
  }
  const note = h.state ? H3_STATES[h.state] : undefined;
  if (!note) {
    return {
      service: 'imageGen', status: 'disconnected', latency, details,
      error: h.wanted
        ? 'H3 Image is up, but its model failed to load (the next picture tries again)'
        : 'H3 Image is up, but its model is switched off (the next picture loads it first)',
    };
  }
  return { service: 'imageGen', status: 'connected', latency, details: { ...details, note } };
}

async function checkImageGen(forgeEndpoint: string): Promise<HealthResult> {
  const { imageGen, engines } = await imageEnginesInUse();
  const results = await Promise.all(engines.map(async (engine) => {
    if (engine === 'h3image') return checkH3Image(imageGen);
    const r = await checkService('imageGen', forgeEndpoint, healthPaths.imageGen);
    return { ...r, details: { engine: 'forge', provider: 'Forge', endpoint: forgeEndpoint } };
  }));
  if (results.length === 1) return results[0];
  const down = results.filter((r) => r.status !== 'connected');
  return {
    service: 'imageGen',
    status: down.length ? 'disconnected' : 'connected',
    latency: Math.max(...results.map((r) => r.latency || 0)) || undefined,
    error: down.map((r) => `${r.details?.provider}: ${r.error}`).join('; ') || undefined,
    details: {
      engine: engines.join('+'),
      provider: results.map((r) => r.details?.provider).join(' + '),
      note: results.map((r) => `${r.details?.provider} ${r.status === 'connected' ? (r.details?.note || 'up') : 'down'}`).join(', '),
    },
  };
}

function buildWeatherCheck(settings?: { provider?: string; apiKey?: string }): HealthResult {
  const provider = settings?.provider || 'openweathermap';
  const apiKey = settings?.apiKey || process.env.OPENWEATHER_API_KEY || process.env.WEATHERAPI_KEY || '';
  const label = provider === 'openweathermap' ? 'OpenWeatherMap' : 'WeatherAPI';
  return checkApiKeyConfigured('weather', label, apiKey);
}

function buildSearchCheck(settings?: { provider?: string; braveApiKey?: string; serpApiKey?: string }): HealthResult {
  const provider = settings?.provider || 'brave';
  if (provider === 'brave') {
    const key = settings?.braveApiKey || process.env.BRAVE_API_KEY || '';
    return checkApiKeyConfigured('search', 'Brave Search', key);
  } else if (provider === 'serpapi') {
    const key = settings?.serpApiKey || process.env.SERPAPI_KEY || '';
    return checkApiKeyConfigured('search', 'SerpAPI', key);
  }
  // searxng as primary search — check via the searxng service check
  return { service: 'search', status: 'connected', details: { provider: 'SearXNG (see SearXNG service)' } };
}

// GET /api/health - Check all services (uses env defaults)
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const service = searchParams.get('service');

  // If specific service requested
  if (service === 'imageGen') return NextResponse.json(await checkImageGen(defaultEndpoints.imageGen));
  if (service && service in defaultEndpoints) {
    const endpoint = defaultEndpoints[service as keyof typeof defaultEndpoints];
    const paths = healthPaths[service] || ['/health', '/'];
    const result = await checkService(service, endpoint, paths);
    return NextResponse.json(result);
  }

  // Check all services in parallel
  const results = await Promise.all([
    checkService('llm', defaultEndpoints.llm, healthPaths.llm),
    checkService('memory', defaultEndpoints.memory, healthPaths.memory),
    checkService('tts', defaultEndpoints.tts, healthPaths.tts),
    checkService('stt', defaultEndpoints.stt, healthPaths.stt),
    checkImageGen(defaultEndpoints.imageGen),
    buildWeatherCheck(),
    buildSearchCheck(),
    checkService('searxng', defaultEndpoints.searxng, healthPaths.searxng),
  ]);

  const healthMap = results.reduce(
    (acc, r) => {
      acc[r.service] = r;
      return acc;
    },
    {} as Record<string, HealthResult>
  );

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    services: healthMap,
    allConnected: results.every((r) => r.status === 'connected'),
    connectedCount: results.filter((r) => r.status === 'connected').length,
    totalCount: results.length,
  });
}

// POST /api/health - Check services with custom endpoints from settings
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { endpoints, weather, search } = body;

    // Use provided endpoints or fall back to defaults
    const serviceEndpoints = {
      llm: endpoints?.llm || defaultEndpoints.llm,
      memory: endpoints?.memory || defaultEndpoints.memory,
      tts: endpoints?.tts || defaultEndpoints.tts,
      stt: endpoints?.stt || defaultEndpoints.stt,
      imageGen: endpoints?.imageGen || defaultEndpoints.imageGen,
      searxng: endpoints?.searxng || defaultEndpoints.searxng,
    };

    // Check all services in parallel
    const results = await Promise.all([
      checkService('llm', serviceEndpoints.llm, healthPaths.llm),
      checkService('memory', serviceEndpoints.memory, healthPaths.memory),
      checkService('tts', serviceEndpoints.tts, healthPaths.tts),
      checkService('stt', serviceEndpoints.stt, healthPaths.stt),
      checkImageGen(serviceEndpoints.imageGen),
      buildWeatherCheck(weather),
      buildSearchCheck(search),
      checkService('searxng', serviceEndpoints.searxng, healthPaths.searxng),
    ]);

    const healthMap = results.reduce(
      (acc, r) => {
        acc[r.service] = r;
        return acc;
      },
      {} as Record<string, HealthResult>
    );

    return NextResponse.json({
      timestamp: new Date().toISOString(),
      services: healthMap,
      allConnected: results.every((r) => r.status === 'connected'),
      connectedCount: results.filter((r) => r.status === 'connected').length,
      totalCount: results.length,
    });
  } catch (error) {
    console.error('Health check error:', error);
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
}
