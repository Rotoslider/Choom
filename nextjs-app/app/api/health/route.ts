import { NextRequest, NextResponse } from 'next/server';

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
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const url = `${endpoint}${healthPath}`;
      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'Accept': 'application/json',
        },
      });

      clearTimeout(timeout);
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
  avatar: ['/health'],
};

// Default endpoints from environment
const defaultEndpoints = {
  llm: process.env.LLM_ENDPOINT || 'http://localhost:1234/v1',
  memory: process.env.MEMORY_ENDPOINT || 'http://localhost:8100',
  tts: process.env.TTS_ENDPOINT || 'http://localhost:8004',
  stt: process.env.STT_ENDPOINT || 'http://localhost:5000',
  imageGen: process.env.IMAGE_GEN_ENDPOINT || 'http://localhost:7860',
  searxng: process.env.SEARXNG_ENDPOINT || 'http://localhost:8888',
  avatar: process.env.AVATAR_SERVICE_URL || 'http://127.0.0.1:8020',
};

function buildWeatherCheck(settings?: { provider?: string; apiKey?: string }): HealthResult {
  const provider = settings?.provider || 'openweathermap';
  const apiKey = settings?.apiKey || process.env.OPENWEATHERMAP_API_KEY || process.env.WEATHERAPI_KEY || '';
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
    checkService('imageGen', defaultEndpoints.imageGen, healthPaths.imageGen),
    buildWeatherCheck(),
    buildSearchCheck(),
    checkService('searxng', defaultEndpoints.searxng, healthPaths.searxng),
    checkService('avatar', defaultEndpoints.avatar, healthPaths.avatar),
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
      avatar: endpoints?.avatar || defaultEndpoints.avatar,
    };

    // Check all services in parallel
    const results = await Promise.all([
      checkService('llm', serviceEndpoints.llm, healthPaths.llm),
      checkService('memory', serviceEndpoints.memory, healthPaths.memory),
      checkService('tts', serviceEndpoints.tts, healthPaths.tts),
      checkService('stt', serviceEndpoints.stt, healthPaths.stt),
      checkService('imageGen', serviceEndpoints.imageGen, healthPaths.imageGen),
      buildWeatherCheck(weather),
      buildSearchCheck(search),
      checkService('searxng', serviceEndpoints.searxng, healthPaths.searxng),
      checkService('avatar', serviceEndpoints.avatar, healthPaths.avatar),
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
