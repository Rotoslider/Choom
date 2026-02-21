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

// Health check paths for each service (in order of preference)
const healthPaths: Record<string, string[]> = {
  llm: ['/models', '/v1/models', '/'],
  memory: ['/memory/stats', '/', '/health'],
  tts: ['/v1/voices', '/voices', '/', '/health'],
  stt: ['/health', '/', '/v1/audio/transcriptions'],
  imageGen: ['/sdapi/v1/options', '/sdapi/v1/sd-models', '/'],
};

// Default endpoints from environment
const defaultEndpoints = {
  llm: process.env.LLM_ENDPOINT || 'http://localhost:1234/v1',
  memory: process.env.MEMORY_ENDPOINT || 'http://localhost:8100',
  tts: process.env.TTS_ENDPOINT || 'http://localhost:8004',
  stt: process.env.STT_ENDPOINT || 'http://localhost:5000',
  imageGen: process.env.IMAGE_GEN_ENDPOINT || 'http://localhost:7860',
};

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
    const { endpoints } = body;

    // Use provided endpoints or fall back to defaults
    const serviceEndpoints = {
      llm: endpoints?.llm || defaultEndpoints.llm,
      memory: endpoints?.memory || defaultEndpoints.memory,
      tts: endpoints?.tts || defaultEndpoints.tts,
      stt: endpoints?.stt || defaultEndpoints.stt,
      imageGen: endpoints?.imageGen || defaultEndpoints.imageGen,
    };

    // Check all services in parallel
    const results = await Promise.all([
      checkService('llm', serviceEndpoints.llm, healthPaths.llm),
      checkService('memory', serviceEndpoints.memory, healthPaths.memory),
      checkService('tts', serviceEndpoints.tts, healthPaths.tts),
      checkService('stt', serviceEndpoints.stt, healthPaths.stt),
      checkService('imageGen', serviceEndpoints.imageGen, healthPaths.imageGen),
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
