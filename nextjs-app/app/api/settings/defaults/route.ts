import { NextResponse } from 'next/server';

/**
 * GET /api/settings/defaults
 *
 * Returns the server's configured endpoints and API keys from environment variables.
 * Remote browsers (e.g. via ngrok) use this to bootstrap their localStorage with
 * the correct values instead of localhost defaults that only work on the LAN.
 */
export async function GET() {
  return NextResponse.json({
    llm: {
      endpoint: process.env.LLM_ENDPOINT || 'http://localhost:1234/v1',
      model: process.env.LLM_MODEL || 'local-model',
    },
    tts: {
      endpoint: process.env.TTS_ENDPOINT || 'http://localhost:8004',
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
      endpoint: process.env.VISION_ENDPOINT || 'http://localhost:1234',
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
