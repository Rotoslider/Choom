/**
 * Server-side fallback settings for the chat route — used when the client
 * doesn't send its own. Moved verbatim out of app/api/chat/route.ts (C-22);
 * shared by the route and the tool-execution module.
 */
import type { LLMSettings, WeatherSettings, SearchSettings, ImageGenSettings } from '@/lib/types';

// Default LLM settings (fallback if client doesn't send settings)
export const defaultLLMSettings: LLMSettings = {
  endpoint: process.env.LLM_ENDPOINT || 'http://localhost:1234/v1',
  model: process.env.LLM_MODEL || 'local-model',
  temperature: 0.7,
  maxTokens: 4096,
  contextLength: 262144, // Qwen native max (256K); profiles override per-model
  topP: 0.95,
  frequencyPenalty: 0,
  presencePenalty: 0,
};

// Default memory endpoint
export const DEFAULT_MEMORY_ENDPOINT = process.env.MEMORY_ENDPOINT || 'http://localhost:8100';

// Default image generation endpoint
export const DEFAULT_IMAGE_GEN_ENDPOINT = process.env.IMAGE_GEN_ENDPOINT || 'http://localhost:7860';

// Default weather settings
export const defaultWeatherSettings: WeatherSettings = {
  apiKey: process.env.OPENWEATHER_API_KEY || '',
  provider: 'openweathermap',
  location: process.env.DEFAULT_WEATHER_LOCATION || '',
  latitude: parseFloat(process.env.DEFAULT_WEATHER_LAT || '0'),
  longitude: parseFloat(process.env.DEFAULT_WEATHER_LON || '0'),
  useCoordinates: true,
  units: 'imperial',
  cacheMinutes: 30,
};

// Default search settings
export const defaultSearchSettings: SearchSettings = {
  provider: 'brave',
  braveApiKey: process.env.BRAVE_API_KEY || '',
  searxngEndpoint: process.env.SEARXNG_ENDPOINT || '',
  serpApiKey: process.env.SERP_API_KEY || '',
  maxResults: 5,
};

// Default image generation settings
export const defaultImageGenSettings: ImageGenSettings = {
  endpoint: DEFAULT_IMAGE_GEN_ENDPOINT,
  defaultCheckpoint: '',
  defaultSampler: 'Euler a',
  defaultScheduler: 'Normal',
  defaultSteps: 20,
  defaultCfgScale: 7,
  defaultDistilledCfg: 3.5,
  defaultWidth: 1024,
  defaultHeight: 1024,
  defaultNegativePrompt: 'ugly, blurry, low quality, deformed, disfigured',
  selfPortrait: {
    enabled: false,
    checkpoint: '',
    sampler: 'Euler a',
    scheduler: 'Normal',
    steps: 25,
    cfgScale: 7,
    distilledCfg: 3.5,
    width: 1024,
    height: 1024,
    negativePrompt: '',
    loras: [],
    promptPrefix: '',
    promptSuffix: '',
  },
};
