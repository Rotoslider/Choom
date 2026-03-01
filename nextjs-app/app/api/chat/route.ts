import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { LLMClient, ChatMessage, accumulateToolCalls } from '@/lib/llm-client';
import { MemoryClient, executeMemoryTool } from '@/lib/memory-client';
import { ImageGenClient, buildPromptWithLoras } from '@/lib/image-gen-client';
import { WeatherService } from '@/lib/weather-service';
import { HomeAssistantService, type HomeAssistantSettings } from '@/lib/homeassistant-service';
import { WebSearchService } from '@/lib/web-search';
import { WorkspaceService } from '@/lib/workspace-service';
import { VisionService } from '@/lib/vision-service';
import { ProjectService } from '@/lib/project-service';
import type { VisionSettings, LLMProviderConfig, LLMModelProfile, VisionModelProfile } from '@/lib/types';
import { findLLMProfile, findVisionProfile } from '@/lib/model-profiles';
import { allTools, memoryTools, getAllToolsFromSkills, useSkillDispatch } from '@/lib/tool-definitions';
import { loadCoreSkills, loadCustomSkills } from '@/lib/skill-loader';
import { getSkillRegistry } from '@/lib/skill-registry';
import type { SkillHandlerContext } from '@/lib/skill-handler';
import { getGoogleClient } from '@/lib/google-client';
import { CompactionService } from '@/lib/compaction-service';
import { getTimeContext, formatTimeContextForPrompt } from '@/lib/time-context';
import { isMultiStepRequest, createPlan, executePlan, summarizePlan } from '@/lib/planner-loop';
import { WatcherLoop } from '@/lib/watcher-loop';
import type { LLMSettings, ToolCall, ToolResult, ToolDefinition, ImageGenSettings, WeatherSettings, SearchSettings, ImageSize, ImageAspect } from '@/lib/types';
import { computeImageDimensions } from '@/lib/types';
import * as fs from 'fs';
import * as path from 'path';

// Smart merge: skip empty strings, null, and undefined values so GUI defaults
// don't clobber real .env / bridge-config values.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function smartMerge<T extends Record<string, any>>(defaults: T, overrides: Partial<T> | undefined): T {
  if (!overrides) return { ...defaults };
  const result = { ...defaults };
  for (const key of Object.keys(overrides) as (keyof T)[]) {
    const val = overrides[key];
    if (val === '' || val === null || val === undefined) continue;
    result[key] = val as T[keyof T];
  }
  return result;
}

// GUI activity tracking — write a per-Choom timestamp file so the Python
// heartbeat scheduler can detect active GUI conversations and defer.
const ACTIVITY_DIR = path.join(process.cwd(), 'services', 'signal-bridge', '.gui-activity');
function recordGuiActivity(choomName: string) {
  try {
    if (!fs.existsSync(ACTIVITY_DIR)) fs.mkdirSync(ACTIVITY_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(ACTIVITY_DIR, `${choomName.toLowerCase()}.ts`),
      Date.now().toString(),
      'utf-8'
    );
  } catch { /* non-critical */ }
}
function clearGuiActivity(choomName: string) {
  try {
    const f = path.join(ACTIVITY_DIR, `${choomName.toLowerCase()}.ts`);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  } catch { /* non-critical */ }
}

// Default LLM settings (fallback if client doesn't send settings)
const defaultLLMSettings: LLMSettings = {
  endpoint: process.env.LLM_ENDPOINT || 'http://localhost:1234/v1',
  model: process.env.LLM_MODEL || 'local-model',
  temperature: 0.7,
  maxTokens: 4096,
  contextLength: 131072,
  topP: 0.95,
  frequencyPenalty: 0,
  presencePenalty: 0,
};

// Default memory endpoint
const DEFAULT_MEMORY_ENDPOINT = process.env.MEMORY_ENDPOINT || 'http://localhost:8100';

// Default image generation endpoint
const DEFAULT_IMAGE_GEN_ENDPOINT = process.env.IMAGE_GEN_ENDPOINT || 'http://localhost:7860';

// Default weather settings
const defaultWeatherSettings: WeatherSettings = {
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
const defaultSearchSettings: SearchSettings = {
  provider: 'brave',
  braveApiKey: process.env.BRAVE_API_KEY || '',
  searxngEndpoint: process.env.SEARXNG_ENDPOINT || '',
  maxResults: 5,
};

// Default image generation settings
const defaultImageGenSettings: ImageGenSettings = {
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

// Default workspace settings
import { WORKSPACE_ROOT } from '@/lib/config';

const WORKSPACE_MAX_FILES_PER_SESSION = 50;
const WORKSPACE_MAX_FILE_SIZE_KB = 1024;
const WORKSPACE_ALLOWED_EXTENSIONS = ['.md', '.txt', '.json', '.py', '.ts', '.js', '.html', '.css', '.csv'];
const WORKSPACE_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp'];
const WORKSPACE_DOWNLOAD_EXTENSIONS = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.pptx', '.zip', '.tar', '.gz', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.log', '.sh', '.bash', '.sql', '.r', '.R', '.ipynb'];

// Maximum agentic loop iterations
const MAX_ITERATIONS = 25;

// Global lock for image generation to prevent checkpoint race conditions
// when multiple requests try to switch checkpoints simultaneously
let imageGenLock: Promise<void> = Promise.resolve();
function withImageGenLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = imageGenLock;
  let resolve: () => void;
  imageGenLock = new Promise<void>(r => { resolve = r; });
  return prev.then(fn).finally(() => resolve!());
}

// Auto-detect checkpoint type from name when not explicitly set
function detectCheckpointType(checkpointName: string): 'pony' | 'flux' | 'other' {
  const lower = checkpointName.toLowerCase();
  if (lower.includes('pony') || lower.includes('cyberrealistic')) return 'pony';
  if (lower.includes('flux')) return 'flux';
  return 'other';
}

// Server-side activity logging - writes directly to DB so both Signal and web GUI get logged
async function serverLog(
  choomId: string, chatId: string,
  level: string, category: string,
  title: string, message: string,
  details?: unknown, duration?: number
) {
  try {
    await prisma.activityLog.create({
      data: { choomId, chatId, level, category, title, message,
              details: details ? JSON.stringify(details) : null,
              duration: duration || null }
    });
  } catch { /* don't let logging failures break chat */ }
}

// ============================================================================
// Tool execution context
// ============================================================================

interface ToolContext {
  memoryClient: MemoryClient;
  memoryCompanionId: string;
  weatherSettings: WeatherSettings;
  settings: Record<string, unknown>;
  imageGenSettings: ImageGenSettings;
  choom: Record<string, unknown>;
  choomId: string;
  chatId: string;
  message: string;
  send: (data: Record<string, unknown>) => void;
  sessionFileCount: { created: number; maxAllowed: number };
}

// ============================================================================
// Extracted tool execution function
// ============================================================================

async function executeToolCall(
  toolCall: ToolCall,
  ctx: ToolContext
): Promise<ToolResult> {
  const { memoryClient, memoryCompanionId, weatherSettings, settings, choom, choomId, chatId, message, send, sessionFileCount } = ctx;

  // Check if it's a memory tool
  if (memoryTools.some((t) => t.name === toolCall.name)) {
    const memoryResult = await executeMemoryTool(
      memoryClient,
      toolCall.name,
      toolCall.arguments,
      memoryCompanionId
    );
    return {
      toolCallId: toolCall.id,
      name: toolCall.name,
      result: memoryResult,
      error: memoryResult.success ? undefined : memoryResult.reason,
    };
  }

  if (toolCall.name === 'get_weather') {
    try {
      const rawLocation = toolCall.arguments.location as string | undefined;
      const vaguePatterns = /^(here|home|rodeo|rodeo,?\s*nm|my (location|area|place|city)|nearby|near me|close by|local|current|this area|around here)$/i;
      const location = rawLocation?.trim() && !vaguePatterns.test(rawLocation.trim()) ? rawLocation.trim() : undefined;
      const weatherService = new WeatherService(weatherSettings);
      const weather = await weatherService.getWeather(location);
      const formatted = weatherService.formatWeatherForPrompt(weather);

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: { success: true, weather, formatted },
      };
    } catch (weatherError) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Weather fetch failed: ${weatherError instanceof Error ? weatherError.message : 'Unknown error'}`,
      };
    }
  }

  if (toolCall.name === 'get_weather_forecast') {
    try {
      const rawLocation = toolCall.arguments.location as string | undefined;
      const vaguePatterns = /^(here|home|rodeo|rodeo,?\s*nm|my (location|area|place|city)|nearby|near me|close by|local|current|this area|around here)$/i;
      const location = rawLocation?.trim() && !vaguePatterns.test(rawLocation.trim()) ? rawLocation.trim() : undefined;
      const days = Math.min(5, Math.max(1, (toolCall.arguments.days as number) || 5));
      const weatherService = new WeatherService(weatherSettings);
      const forecast = await weatherService.getForecast(location, days);
      const formatted = weatherService.formatForecastForPrompt(forecast);

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: { success: true, forecast, formatted },
      };
    } catch (forecastError) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Forecast fetch failed: ${forecastError instanceof Error ? forecastError.message : 'Unknown error'}`,
      };
    }
  }

  if (toolCall.name === 'web_search') {
    try {
      const searchSettings: SearchSettings = {
        ...defaultSearchSettings,
        ...(settings?.search as object),
      };

      console.log(`   🔍 Search settings: provider=${searchSettings.provider}, braveApiKey=${searchSettings.braveApiKey ? '***' + searchSettings.braveApiKey.slice(-4) : '(empty)'}, searxng=${searchSettings.searxngEndpoint || '(empty)'}`);

      if (searchSettings.provider === 'brave' && !searchSettings.braveApiKey) {
        throw new Error('Brave Search API key not configured. Set BRAVE_API_KEY in .env or configure in Settings > Search.');
      }
      if (searchSettings.provider === 'searxng' && !searchSettings.searxngEndpoint) {
        throw new Error('SearXNG endpoint not configured. Set SEARXNG_ENDPOINT in .env or configure in Settings > Search.');
      }

      const query = toolCall.arguments.query as string;
      const maxResults = toolCall.arguments.max_results as number | undefined;

      console.log(`   🔍 Executing web search: "${query}"`);

      const searchService = new WebSearchService(searchSettings);
      const searchResponse = await searchService.search(query, maxResults);

      const formattedResults = searchResponse.results
        .map((r, i) => `${i + 1}. **[${r.title}](${r.url})**\n   ${r.snippet}`)
        .join('\n\n');

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: {
          success: true,
          query: searchResponse.query,
          totalResults: searchResponse.totalResults,
          results: searchResponse.results,
          formatted: formattedResults,
        },
      };
    } catch (searchError) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Web search failed: ${searchError instanceof Error ? searchError.message : 'Unknown error'}`,
      };
    }
  }

  if (toolCall.name === 'generate_image') {
    try {
      const imageGenEndpoint = (settings?.imageGen as Record<string, unknown>)?.endpoint as string || DEFAULT_IMAGE_GEN_ENDPOINT;
      const imageGenSettings: ImageGenSettings = {
        ...defaultImageGenSettings,
        ...(settings?.imageGen as object),
        endpoint: imageGenEndpoint,
      };
      const imageGenClient = new ImageGenClient(imageGenSettings);

      // Get Choom-specific image settings if available
      const choomImageSettings = choom.imageSettings ? JSON.parse(choom.imageSettings as string) : null;

      // Determine if this is a self-portrait or general image
      let isSelfPortrait = toolCall.arguments.self_portrait === true;
      if (!isSelfPortrait) {
        const promptLower = ((toolCall.arguments.prompt as string) || '').toLowerCase();
        const messageLower = message.toLowerCase();
        const selfiePatterns = [
          /\bself[- ]?portrait\b/, /\bselfie\b/, /\bpicture of (?:me|you|yourself|myself)\b/,
          /\bphoto of (?:me|you|yourself|myself)\b/, /\bimage of (?:me|you|yourself|myself)\b/,
          /\bdraw (?:me|you|yourself|myself)\b/, /\bshow (?:me |)(?:you|yourself)\b/,
          /\bwhat (?:do )?(?:you|i) look like\b/, /\byour (?:face|appearance|look)\b/,
        ];
        const isSelfieRequest = selfiePatterns.some(p => p.test(messageLower) || p.test(promptLower));
        if (isSelfieRequest && choomImageSettings?.selfPortrait) {
          console.log(`   🔄 Self-portrait override: LLM said self_portrait=false but detected selfie request in prompt/message`);
          isSelfPortrait = true;
        }
      }

      // Get the appropriate mode settings
      const modeSettings = isSelfPortrait
        ? choomImageSettings?.selfPortrait || {}
        : choomImageSettings?.general || {};

      // Set checkpoint based on mode (Layer 3 Choom > Layer 2 settings panel > none)
      const checkpoint = modeSettings.checkpoint || (settings?.imageGen as Record<string, unknown>)?.defaultCheckpoint;
      console.log(`   🖼️  Image Checkpoint Resolution:`);
      console.log(`      Mode (${isSelfPortrait ? 'selfPortrait' : 'general'}): checkpoint=${modeSettings.checkpoint || '(not set)'}`);
      console.log(`      Settings panel default: checkpoint=${(settings?.imageGen as Record<string, unknown>)?.defaultCheckpoint || '(not set)'}`);
      console.log(`      ✅ RESOLVED checkpoint: ${checkpoint || '(none - using current)'}`);
      // Auto-detect checkpoint type from name if not explicitly set
      const checkpointType = modeSettings.checkpointType || (checkpoint ? detectCheckpointType(checkpoint) : 'other');

      // Build the prompt (before lock, since this is CPU-only)
      let prompt = toolCall.arguments.prompt as string;

      if (isSelfPortrait && modeSettings.characterPrompt) {
        prompt = `${modeSettings.characterPrompt}, ${prompt}`;
      }
      if (modeSettings.promptPrefix) {
        prompt = `${modeSettings.promptPrefix}, ${prompt}`;
      }
      if (modeSettings.promptSuffix) {
        prompt = `${prompt}, ${modeSettings.promptSuffix}`;
      }

      const validLoras = (modeSettings.loras || []).filter((l: { name: string }) => l.name && l.name.trim() !== '');
      if (validLoras.length > 0) {
        prompt = buildPromptWithLoras(prompt, validLoras);
        console.log(`   🎨 Applied ${validLoras.length} LoRA(s): ${validLoras.map((l: { name: string; weight: number }) => `${l.name}:${l.weight}`).join(', ')}`);
      }

      // Resolve dimensions
      let genWidth: number;
      let genHeight: number;

      if (toolCall.arguments.width && toolCall.arguments.height) {
        genWidth = toolCall.arguments.width as number;
        genHeight = toolCall.arguments.height as number;
      } else {
        const size = (toolCall.arguments.size as ImageSize) || modeSettings.size || 'medium';
        const aspect = (toolCall.arguments.aspect as ImageAspect) || modeSettings.aspect
          || (isSelfPortrait ? 'portrait' : 'square');

        const dims = computeImageDimensions(size, aspect);
        genWidth = dims.width;
        genHeight = dims.height;
      }

      console.log(`   📐 Image dimensions: ${genWidth}x${genHeight} (self_portrait=${isSelfPortrait})`);

      // Select CFG parameters based on checkpoint type
      let genCfgScale: number;
      let genDistilledCfg: number;

      if (checkpointType === 'flux') {
        genCfgScale = 1;
        genDistilledCfg = modeSettings.distilledCfg || imageGenSettings.defaultDistilledCfg;
      } else if (checkpointType === 'pony') {
        genCfgScale = modeSettings.cfgScale || imageGenSettings.defaultCfgScale;
        genDistilledCfg = 0;
      } else {
        genCfgScale = modeSettings.cfgScale || imageGenSettings.defaultCfgScale;
        genDistilledCfg = modeSettings.distilledCfg || imageGenSettings.defaultDistilledCfg;
      }

      console.log(`   🔧 Generation params: type=${checkpointType}, cfgScale=${genCfgScale}, distilledCfg=${genDistilledCfg}`);

      // Use image generation lock to serialize checkpoint switch + generation
      // This prevents race conditions when multiple requests try to switch checkpoints
      const { genResult, finalImageUrl } = await withImageGenLock(async () => {
        if (checkpoint) {
          console.log(`   ⏳ Switching checkpoint to: ${checkpoint} (type: ${checkpointType})`);
          await imageGenClient.setCheckpointWithModules(checkpoint, checkpointType);
          const stripHash = (s: string) => s.replace(/\s*\[[\da-f]+\]$/i, '').trim();
          const maxWait = 120000;
          const pollInterval = 2000;
          const startTime = Date.now();
          let loaded = false;
          while (Date.now() - startTime < maxWait) {
            const opts = await imageGenClient.getOptions();
            const currentModel = stripHash(opts.sd_model_checkpoint as string || '');
            const targetModel = stripHash(checkpoint);
            if (currentModel === targetModel) {
              loaded = true;
              break;
            }
            console.log(`   ⏳ Waiting for checkpoint load... (current: ${currentModel}, target: ${targetModel})`);
            await new Promise(r => setTimeout(r, pollInterval));
          }
          if (loaded) {
            console.log(`   ✅ Checkpoint loaded in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
          } else {
            console.warn(`   ⚠️ Checkpoint may not have loaded after ${maxWait/1000}s, proceeding anyway`);
          }
        }

        const result = await imageGenClient.generate({
          prompt,
          negativePrompt: toolCall.arguments.negative_prompt as string || modeSettings.negativePrompt || imageGenSettings.defaultNegativePrompt,
          width: genWidth,
          height: genHeight,
          steps: toolCall.arguments.steps as number || modeSettings.steps || imageGenSettings.defaultSteps,
          cfgScale: genCfgScale,
          distilledCfg: genDistilledCfg,
          sampler: modeSettings.sampler || imageGenSettings.defaultSampler,
          scheduler: modeSettings.scheduler || imageGenSettings.defaultScheduler,
          isSelfPortrait,
        });

        // Upscale if configured or user requested (still inside lock — same checkpoint needed)
        const userPromptLower = (toolCall.arguments.prompt as string || '').toLowerCase();
        const userRequestedUpscale = /\b(upscale|high[- ]?res|2x|hires)\b/.test(userPromptLower);
        let imageUrl = result.imageUrl;
        if (modeSettings.upscale || userRequestedUpscale) {
          try {
            console.log(`   🔍 Upscaling image 2x with Lanczos...`);
            const base64Data = result.imageUrl.split(',')[1] || result.imageUrl;
            imageUrl = await imageGenClient.upscaleImage(base64Data);
            console.log(`   ✅ Upscale complete`);
          } catch (upscaleError) {
            console.warn(`   ⚠️ Upscale failed, using original:`, upscaleError instanceof Error ? upscaleError.message : upscaleError);
          }
        }

        return { genResult: result, finalImageUrl: imageUrl };
      });

      // Save generated image to database
      const savedImage = await prisma.generatedImage.create({
        data: {
          choomId,
          prompt,
          imageUrl: finalImageUrl,
          settings: JSON.stringify(genResult.settings),
        },
      });

      // Enforce per-Choom image limit (keep last 50)
      const MAX_IMAGES_PER_CHOOM = 50;
      const allImages = await prisma.generatedImage.findMany({
        where: { choomId },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (allImages.length > MAX_IMAGES_PER_CHOOM) {
        const idsToDelete = allImages.slice(MAX_IMAGES_PER_CHOOM).map((img) => img.id);
        await prisma.generatedImage.deleteMany({
          where: { id: { in: idsToDelete } },
        });
      }

      // Send the image to the client for display
      send({
        type: 'image_generated',
        imageUrl: finalImageUrl,
        imageId: savedImage.id,
        prompt,
      });

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: {
          success: true,
          message: `Image generated successfully with seed ${genResult.seed}${modeSettings.upscale ? ' (upscaled 2x)' : ''}. The image has been displayed to the user. To analyze this image, call analyze_image with image_id="${savedImage.id}".`,
          imageId: savedImage.id,
        },
      };
    } catch (imageError) {
      console.error(`   ❌ Image generation FAILED:`, imageError instanceof Error ? imageError.message : imageError);
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Image generation failed: ${imageError instanceof Error ? imageError.message : 'Unknown error'}`,
      };
    }
  }

  if (toolCall.name === 'get_calendar_events') {
    try {
      const daysAhead = (toolCall.arguments.days_ahead as number) || 7;
      const daysBack = toolCall.arguments.days_back as number | undefined;
      const query = toolCall.arguments.query as string | undefined;
      const googleClient = getGoogleClient();
      const events = await googleClient.getCalendarEvents(daysAhead, query, daysBack);

      const formatted = events.length === 0
        ? daysBack ? 'No events found in that time range.' : 'No upcoming events found.'
        : events.map(e => {
            const start = e.start ? new Date(e.start).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Denver' }) : 'All day';
            return `- ${e.summary} (${start})${e.location ? ` @ ${e.location}` : ''}`;
          }).join('\n');

      console.log(`   📅 Calendar: ${events.length} events found (${daysBack ? `${daysBack} days back, ` : ''}${daysAhead} days ahead)`);

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: { success: true, events, formatted, count: events.length },
      };
    } catch (calError) {
      console.error('   ❌ Calendar error:', calError instanceof Error ? calError.message : calError);
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Calendar fetch failed: ${calError instanceof Error ? calError.message : 'Unknown error'}`,
      };
    }
  }

  if (toolCall.name === 'create_calendar_event') {
    try {
      const summary = toolCall.arguments.summary as string;
      const startTime = toolCall.arguments.start_time as string;
      let endTime = toolCall.arguments.end_time as string | undefined;
      const description = toolCall.arguments.description as string | undefined;
      const location = toolCall.arguments.location as string | undefined;
      const allDay = toolCall.arguments.all_day as boolean | undefined;

      // Default end time to 1 hour after start if not provided
      if (!endTime && !allDay) {
        const start = new Date(startTime);
        start.setHours(start.getHours() + 1);
        endTime = start.toISOString().replace('Z', '');
      } else if (!endTime && allDay) {
        // All-day: end is next day
        const start = new Date(startTime);
        start.setDate(start.getDate() + 1);
        endTime = start.toISOString().slice(0, 10);
      }

      const googleClient = getGoogleClient();
      const event = await googleClient.createCalendarEvent(summary, startTime, endTime!, {
        description, location, allDay,
      });

      console.log(`   📅 Created calendar event: "${summary}"`);

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: { success: true, event, message: `Created calendar event "${summary}".` },
      };
    } catch (err) {
      console.error('   ❌ Create calendar event error:', err instanceof Error ? err.message : err);
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Failed to create calendar event: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  }

  if (toolCall.name === 'update_calendar_event') {
    try {
      const eventId = toolCall.arguments.event_id as string;
      const googleClient = getGoogleClient();
      const result = await googleClient.updateCalendarEvent(eventId, {
        summary: toolCall.arguments.summary as string | undefined,
        startTime: toolCall.arguments.start_time as string | undefined,
        endTime: toolCall.arguments.end_time as string | undefined,
        description: toolCall.arguments.description as string | undefined,
        location: toolCall.arguments.location as string | undefined,
      });

      console.log(`   📅 Updated calendar event: ${eventId}`);

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: { success: true, event: result, message: `Updated calendar event.` },
      };
    } catch (err) {
      console.error('   ❌ Update calendar event error:', err instanceof Error ? err.message : err);
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Failed to update calendar event: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  }

  if (toolCall.name === 'delete_calendar_event') {
    try {
      const eventId = toolCall.arguments.event_id as string;
      const googleClient = getGoogleClient();
      await googleClient.deleteCalendarEvent(eventId);

      console.log(`   🗑️ Deleted calendar event: ${eventId}`);

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: { success: true, message: `Deleted calendar event.` },
      };
    } catch (err) {
      console.error('   ❌ Delete calendar event error:', err instanceof Error ? err.message : err);
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Failed to delete calendar event: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  }

  // Google Sheets tools
  if (toolCall.name === 'list_spreadsheets') {
    try {
      const maxResults = (toolCall.arguments.max_results as number) || 20;
      const googleClient = getGoogleClient();
      const spreadsheets = await googleClient.listSpreadsheets(maxResults);

      const formatted = spreadsheets.length === 0
        ? 'No spreadsheets found.'
        : spreadsheets.map(s => `- ${s.name} (${s.url})`).join('\n');

      console.log(`   📊 Spreadsheets: ${spreadsheets.length} found`);

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: { success: true, spreadsheets, formatted, count: spreadsheets.length },
      };
    } catch (err) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Failed to list spreadsheets: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  }

  if (toolCall.name === 'create_spreadsheet') {
    try {
      const title = toolCall.arguments.title as string;
      const sheetNames = toolCall.arguments.sheet_names as string[] | undefined;
      const initialData = toolCall.arguments.initial_data;
      const googleClient = getGoogleClient();
      const result = await googleClient.createSpreadsheet(title, sheetNames, initialData as string[][] | undefined);

      console.log(`   📊 Created spreadsheet: "${title}" (${result.id})`);

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: { success: true, spreadsheet: result, message: `Created spreadsheet "${title}". URL: ${result.url}. Tab names: [${(result.sheetNames || ['Sheet1']).join(', ')}]. IMPORTANT: Use these exact tab names (not "Sheet1") when reading/writing this spreadsheet.` },
      };
    } catch (err) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Failed to create spreadsheet: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  }

  if (toolCall.name === 'read_sheet') {
    try {
      const spreadsheetId = toolCall.arguments.spreadsheet_id as string;
      const range = toolCall.arguments.range as string;
      console.log(`   📊 read_sheet: id="${spreadsheetId}", range="${range}"`);
      const googleClient = getGoogleClient();
      const result = await googleClient.readSheet(spreadsheetId, range);

      const formatted = result.values.length === 0
        ? 'No data in that range.'
        : result.values.map(row => row.join('\t')).join('\n');

      console.log(`   📊 Read ${result.values.length} rows from ${spreadsheetId}`);

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: { success: true, ...result, formatted, rowCount: result.values.length },
      };
    } catch (err) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Failed to read sheet: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  }

  if (toolCall.name === 'write_sheet') {
    try {
      const spreadsheetId = toolCall.arguments.spreadsheet_id as string;
      const range = toolCall.arguments.range as string;
      const values = toolCall.arguments.values;
      console.log(`   📊 write_sheet: id="${spreadsheetId}", range="${range}", values type=${typeof values}, isArray=${Array.isArray(values)}`);
      const googleClient = getGoogleClient();
      const result = await googleClient.writeSheet(spreadsheetId, range, values);

      console.log(`   📊 Wrote ${result.updatedRows} rows to ${spreadsheetId}`);

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: { success: true, ...result, message: `Wrote ${result.updatedCells} cells to ${result.updatedRange}.` },
      };
    } catch (err) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Failed to write to sheet: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  }

  if (toolCall.name === 'append_to_sheet') {
    try {
      const spreadsheetId = toolCall.arguments.spreadsheet_id as string;
      const range = toolCall.arguments.range as string;
      const values = toolCall.arguments.values;
      console.log(`   📊 append_to_sheet: id="${spreadsheetId}", range="${range}", values type=${typeof values}, isArray=${Array.isArray(values)}`);
      const googleClient = getGoogleClient();
      const result = await googleClient.appendToSheet(spreadsheetId, range, values);

      console.log(`   📊 Appended ${result.updatedRows} rows to ${spreadsheetId}`);

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: { success: true, ...result, message: `Appended ${result.updatedRows} rows.` },
      };
    } catch (err) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Failed to append to sheet: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  }

  // Google Docs tools
  if (toolCall.name === 'list_documents') {
    try {
      const maxResults = (toolCall.arguments.max_results as number) || 20;
      const googleClient = getGoogleClient();
      const documents = await googleClient.listDocuments(maxResults);

      const formatted = documents.length === 0
        ? 'No documents found.'
        : documents.map(d => `- ${d.name} (${d.url})`).join('\n');

      console.log(`   📄 Documents: ${documents.length} found`);

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: { success: true, documents, formatted, count: documents.length },
      };
    } catch (err) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Failed to list documents: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  }

  if (toolCall.name === 'create_document') {
    try {
      const title = toolCall.arguments.title as string;
      const content = toolCall.arguments.content as string | undefined;
      const googleClient = getGoogleClient();
      const result = await googleClient.createDocument(title, content);

      console.log(`   📄 Created document: "${title}" (${result.id})`);

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: { success: true, document: result, message: `Created document "${title}". URL: ${result.url}` },
      };
    } catch (err) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Failed to create document: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  }

  if (toolCall.name === 'read_document') {
    try {
      const documentId = toolCall.arguments.document_id as string;
      const googleClient = getGoogleClient();
      const result = await googleClient.readDocument(documentId);

      console.log(`   📄 Read document: "${result.title}" (${result.content.length} chars)`);

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: { success: true, ...result },
      };
    } catch (err) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Failed to read document: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  }

  if (toolCall.name === 'append_to_document') {
    try {
      const documentId = toolCall.arguments.document_id as string;
      const text = toolCall.arguments.text as string;
      const googleClient = getGoogleClient();
      const result = await googleClient.appendToDocument(documentId, text);

      console.log(`   📄 Appended ${text.length} chars to document ${documentId}`);

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: { success: true, ...result, message: `Appended ${text.length} characters to document.` },
      };
    } catch (err) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Failed to append to document: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  }

  // Google Drive tools
  if (toolCall.name === 'list_drive_files') {
    try {
      const folderId = toolCall.arguments.folder_id as string | undefined;
      const maxResults = (toolCall.arguments.max_results as number) || 20;
      const googleClient = getGoogleClient();
      const files = await googleClient.listDriveFiles(folderId, maxResults);

      const formatted = files.length === 0
        ? 'No files found.'
        : files.map(f => `- ${f.name} (${f.mimeType}) ${f.url}`).join('\n');

      console.log(`   📁 Drive files: ${files.length} found`);

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: { success: true, files, formatted, count: files.length },
      };
    } catch (err) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Failed to list Drive files: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  }

  if (toolCall.name === 'search_drive') {
    try {
      const query = toolCall.arguments.query as string;
      const maxResults = (toolCall.arguments.max_results as number) || 20;
      const googleClient = getGoogleClient();
      const files = await googleClient.searchDrive(query, maxResults);

      const formatted = files.length === 0
        ? 'No files found matching that search.'
        : files.map(f => `- ${f.name} (${f.mimeType}) ${f.url}`).join('\n');

      console.log(`   🔍 Drive search "${query}": ${files.length} results`);

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: { success: true, files, formatted, count: files.length, query },
      };
    } catch (err) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Failed to search Drive: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  }

  if (toolCall.name === 'create_drive_folder') {
    try {
      const name = toolCall.arguments.name as string;
      const parentId = toolCall.arguments.parent_id as string | undefined;
      const googleClient = getGoogleClient();
      const folder = await googleClient.createDriveFolder(name, parentId);

      console.log(`   📁 Created Drive folder: "${name}" (${folder.id})`);

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: { success: true, folder, message: `Created folder "${name}" in Google Drive.` },
      };
    } catch (err) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Failed to create Drive folder: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  }

  if (toolCall.name === 'upload_to_drive') {
    try {
      const workspacePath = toolCall.arguments.workspace_path as string;
      const folderId = toolCall.arguments.folder_id as string | undefined;
      const driveFilename = toolCall.arguments.drive_filename as string | undefined;

      // Resolve workspace path to absolute path
      const path = await import('path');
      const absolutePath = path.join(WORKSPACE_ROOT, workspacePath);

      // Security: ensure path stays within workspace
      const resolved = path.resolve(absolutePath);
      if (!resolved.startsWith(WORKSPACE_ROOT)) {
        throw new Error('Path traversal not allowed');
      }

      const googleClient = getGoogleClient();
      const result = await googleClient.uploadToDrive(resolved, folderId, driveFilename);

      console.log(`   ☁️ Uploaded to Drive: "${workspacePath}" → ${result.name} (${result.id})`);

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: { success: true, file: result, message: `Uploaded "${workspacePath}" to Google Drive. URL: ${result.url}` },
      };
    } catch (err) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Failed to upload to Drive: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  }

  if (toolCall.name === 'download_from_drive') {
    try {
      const fileId = toolCall.arguments.file_id as string;
      const workspacePath = toolCall.arguments.workspace_path as string;

      // Resolve workspace path to absolute path
      const path = await import('path');
      const absolutePath = path.join(WORKSPACE_ROOT, workspacePath);

      // Security: ensure path stays within workspace
      const resolved = path.resolve(absolutePath);
      if (!resolved.startsWith(WORKSPACE_ROOT)) {
        throw new Error('Path traversal not allowed');
      }

      const googleClient = getGoogleClient();
      await googleClient.downloadFromDrive(fileId, resolved);

      console.log(`   ☁️ Downloaded from Drive: ${fileId} → "${workspacePath}"`);

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: { success: true, path: workspacePath, message: `Downloaded to workspace at "${workspacePath}".` },
      };
    } catch (err) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Failed to download from Drive: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  }

  if (toolCall.name === 'list_task_lists') {
    try {
      const googleClient = getGoogleClient();
      const lists = await googleClient.getTaskLists();
      const formatted = lists.length === 0
        ? 'No task lists found.'
        : lists.map(l => `- ${l.title}`).join('\n');

      console.log(`   📋 Task Lists: ${lists.length} lists found`);

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: { success: true, lists: lists.map(l => l.title), formatted, count: lists.length },
      };
    } catch (listError) {
      console.error('   ❌ List task lists error:', listError instanceof Error ? listError.message : listError);
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Failed to list task lists: ${listError instanceof Error ? listError.message : 'Unknown error'}`,
      };
    }
  }

  if (toolCall.name === 'get_task_list') {
    try {
      const listName = toolCall.arguments.list_name as string;
      const googleClient = getGoogleClient();
      const tasks = await googleClient.getTasksByListName(listName);

      const formatted = tasks.length === 0
        ? `No items on the "${listName}" list.`
        : tasks.map(t => `- ${t.title}${t.notes ? ` (${t.notes})` : ''}`).join('\n');

      console.log(`   📋 Tasks: ${tasks.length} items in "${listName}"`);

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: { success: true, tasks, formatted, count: tasks.length, listName },
      };
    } catch (taskError) {
      console.error('   ❌ Tasks error:', taskError instanceof Error ? taskError.message : taskError);
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Task list fetch failed: ${taskError instanceof Error ? taskError.message : 'Unknown error'}`,
      };
    }
  }

  if (toolCall.name === 'add_to_task_list') {
    try {
      const listName = toolCall.arguments.list_name as string;
      const itemTitle = toolCall.arguments.item_title as string;
      const notes = toolCall.arguments.notes as string | undefined;
      const googleClient = getGoogleClient();
      const task = await googleClient.addTaskToListName(listName, itemTitle, notes);

      console.log(`   ✅ Added "${itemTitle}" to "${listName}"`);

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: { success: true, task, message: `Added "${itemTitle}" to ${listName} list.` },
      };
    } catch (addError) {
      console.error('   ❌ Add task error:', addError instanceof Error ? addError.message : addError);
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Failed to add task: ${addError instanceof Error ? addError.message : 'Unknown error'}`,
      };
    }
  }

  if (toolCall.name === 'remove_from_task_list') {
    try {
      const listName = toolCall.arguments.list_name as string;
      const itemTitle = toolCall.arguments.item_title as string;
      const googleClient = getGoogleClient();
      await googleClient.removeTaskFromListName(listName, itemTitle);

      console.log(`   🗑️ Removed "${itemTitle}" from "${listName}"`);

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: { success: true, message: `Removed "${itemTitle}" from ${listName} list.` },
      };
    } catch (removeError) {
      console.error('   ❌ Remove task error:', removeError instanceof Error ? removeError.message : removeError);
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Failed to remove task: ${removeError instanceof Error ? removeError.message : 'Unknown error'}`,
      };
    }
  }

  if (toolCall.name === 'get_reminders') {
    try {
      const dateFilter = toolCall.arguments.date as string | undefined;
      const baseUrl = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
      const reminderRes = await fetch(`${baseUrl}/api/reminders`, { method: 'GET' });

      if (!reminderRes.ok) {
        throw new Error('Failed to fetch reminders');
      }

      let reminders = await reminderRes.json();

      // Optional date filter
      if (dateFilter) {
        const filterDate = dateFilter.slice(0, 10); // "2026-02-09"
        reminders = reminders.filter((r: { remind_at: string }) => {
          return r.remind_at && r.remind_at.startsWith(filterDate);
        });
      }

      const formatted = reminders.length === 0
        ? 'No pending reminders.'
        : reminders.map((r: { text: string; remind_at: string; id: string }) => {
            const time = new Date(r.remind_at).toLocaleString('en-US', {
              weekday: 'short', month: 'short', day: 'numeric',
              hour: 'numeric', minute: '2-digit', timeZone: 'America/Denver',
            });
            return `- "${r.text}" at ${time}`;
          }).join('\n');

      console.log(`   ⏰ Get reminders: ${reminders.length} found`);

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: { success: true, reminders, formatted, count: reminders.length },
      };
    } catch (err) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Failed to get reminders: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  }

  if (toolCall.name === 'create_reminder') {
    try {
      let text = toolCall.arguments.text as string;
      const minutesFromNow = toolCall.arguments.minutes_from_now as number | undefined;
      const timeStr = toolCall.arguments.time as string | undefined;

      // Clean up text: strip stray time abbreviations like "1.m.", "a.m.", "p.m."
      text = text.replace(/\b\d+\.m\.\s*/gi, '').replace(/\b[ap]\.m\.\s*/gi, '').trim();

      let remindAt: Date;

      if (minutesFromNow) {
        remindAt = new Date(Date.now() + minutesFromNow * 60_000);
      } else if (timeStr) {
        const now = new Date();
        // Match "3:00 PM", "3:00PM", "3:00 pm"
        const match12 = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
        // Match "15:00"
        const match24 = timeStr.match(/^(\d{1,2}):(\d{2})$/);
        // Match bare "4pm", "4 PM", "4PM", "4 am" (no colon)
        const matchBare = timeStr.match(/^(\d{1,2})\s*(AM|PM)$/i);

        if (match12) {
          let hours = parseInt(match12[1]);
          const minutes = parseInt(match12[2]);
          const period = match12[3].toUpperCase();
          if (period === 'PM' && hours !== 12) hours += 12;
          if (period === 'AM' && hours === 12) hours = 0;
          remindAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes);
        } else if (matchBare) {
          let hours = parseInt(matchBare[1]);
          const period = matchBare[2].toUpperCase();
          if (period === 'PM' && hours !== 12) hours += 12;
          if (period === 'AM' && hours === 12) hours = 0;
          remindAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, 0);
        } else if (match24) {
          const hours = parseInt(match24[1]);
          const minutes = parseInt(match24[2]);
          remindAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes);
        } else {
          throw new Error(`Could not parse time: "${timeStr}". Use format like "3:00 PM", "4pm", or "15:00".`);
        }

        if (remindAt.getTime() <= now.getTime()) {
          remindAt.setDate(remindAt.getDate() + 1);
        }
      } else {
        remindAt = new Date(Date.now() + 30 * 60_000);
      }

      // Duplicate detection: check existing reminders for similar text + time within ±30 min
      const baseUrl = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
      try {
        const existingRes = await fetch(`${baseUrl}/api/reminders`, { method: 'GET' });
        if (existingRes.ok) {
          const existing = await existingRes.json();
          const textLower = text.toLowerCase();
          const duplicate = existing.find((r: { text: string; remind_at: string }) => {
            const rTime = new Date(r.remind_at).getTime();
            const timeDiff = Math.abs(rTime - remindAt.getTime());
            const textSimilar = r.text.toLowerCase().includes(textLower) || textLower.includes(r.text.toLowerCase());
            return textSimilar && timeDiff < 30 * 60_000;
          });
          if (duplicate) {
            const existingTime = new Date(duplicate.remind_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Denver' });
            return {
              toolCallId: toolCall.id,
              name: toolCall.name,
              result: {
                success: false,
                message: `A similar reminder already exists: "${duplicate.text}" at ${existingTime}. No duplicate created.`,
              },
            };
          }
        }
      } catch { /* continue if dedup check fails */ }

      const reminderId = `reminder_web_${Date.now()}`;
      const remindAtISO = remindAt.toISOString();

      const reminderRes = await fetch(`${baseUrl}/api/reminders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: reminderId, text, remind_at: remindAtISO }),
      });

      if (!reminderRes.ok) {
        const errText = await reminderRes.text();
        throw new Error(`Failed to save reminder: ${errText}`);
      }

      const minutesUntil = Math.round((remindAt.getTime() - Date.now()) / 60_000);
      const timeFormatted = remindAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Denver' });

      console.log(`   ⏰ Reminder set: "${text}" at ${timeFormatted} (${minutesUntil}min from now)`);

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: {
          success: true,
          message: `Reminder set for ${timeFormatted} (~${minutesUntil} minutes from now). You'll get a Signal message: "${text}"`,
          remind_at: remindAtISO,
        },
      };
    } catch (reminderError) {
      console.error('   ❌ Reminder error:', reminderError instanceof Error ? reminderError.message : reminderError);
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Failed to create reminder: ${reminderError instanceof Error ? reminderError.message : 'Unknown error'}`,
      };
    }
  }

  // Workspace tools
  if (toolCall.name === 'workspace_write_file') {
    try {
      if (sessionFileCount.created >= sessionFileCount.maxAllowed) {
        throw new Error(`Session file limit reached (${sessionFileCount.maxAllowed}). Cannot create more files in this session.`);
      }
      const ws = new WorkspaceService(WORKSPACE_ROOT, WORKSPACE_MAX_FILE_SIZE_KB, WORKSPACE_ALLOWED_EXTENSIONS);
      const filePath = toolCall.arguments.path as string;
      const content = toolCall.arguments.content as string;
      const result = await ws.writeFile(filePath, content);
      sessionFileCount.created++;
      send({ type: 'file_created', path: filePath });
      console.log(`   📝 Workspace: wrote ${filePath} (${content.length} chars)`);
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: { success: true, message: result, path: filePath },
      };
    } catch (err) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Workspace write failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  }

  if (toolCall.name === 'workspace_read_file') {
    try {
      const ws = new WorkspaceService(WORKSPACE_ROOT, WORKSPACE_MAX_FILE_SIZE_KB, WORKSPACE_ALLOWED_EXTENSIONS);
      const filePath = toolCall.arguments.path as string;
      const content = await ws.readFile(filePath);
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: { success: true, content, path: filePath },
      };
    } catch (err) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Workspace read failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  }

  if (toolCall.name === 'workspace_list_files') {
    try {
      const ws = new WorkspaceService(WORKSPACE_ROOT, WORKSPACE_MAX_FILE_SIZE_KB, WORKSPACE_ALLOWED_EXTENSIONS);
      const dirPath = (toolCall.arguments.path as string) || '';
      console.log(`   📂 workspace_list_files: path="${dirPath}" (raw arg: ${JSON.stringify(toolCall.arguments.path)})`);
      const files = await ws.listFiles(dirPath);
      console.log(`   📂 workspace_list_files: found ${files.length} entries`);
      const formatted = files.length === 0
        ? 'No files found.'
        : files.map(f => `- ${f.type === 'directory' ? '📁' : '📄'} ${f.name} ${f.type === 'file' ? `(${f.size} bytes)` : ''}`).join('\n');
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: { success: true, files, formatted, count: files.length },
      };
    } catch (err) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Workspace list failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  }

  if (toolCall.name === 'workspace_create_folder') {
    try {
      if (sessionFileCount.created >= sessionFileCount.maxAllowed) {
        throw new Error(`Session file limit reached (${sessionFileCount.maxAllowed}). Cannot create more files/folders in this session.`);
      }
      const ws = new WorkspaceService(WORKSPACE_ROOT, WORKSPACE_MAX_FILE_SIZE_KB, WORKSPACE_ALLOWED_EXTENSIONS);
      const dirPath = toolCall.arguments.path as string;
      const result = await ws.createFolder(dirPath);
      sessionFileCount.created++;
      console.log(`   📁 Workspace: created folder ${dirPath}`);
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: { success: true, message: result, path: dirPath },
      };
    } catch (err) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Workspace folder creation failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  }

  if (toolCall.name === 'workspace_delete_file') {
    try {
      const ws = new WorkspaceService(WORKSPACE_ROOT, WORKSPACE_MAX_FILE_SIZE_KB, WORKSPACE_ALLOWED_EXTENSIONS);
      const filePath = toolCall.arguments.path as string;
      await ws.deleteFile(filePath);
      console.log(`   🗑️ Workspace: deleted ${filePath}`);
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: { success: true, message: `Deleted ${filePath}` },
      };
    } catch (err) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Workspace delete failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  }

  // Project rename
  if (toolCall.name === 'workspace_rename_project') {
    try {
      const { ProjectService } = await import('@/lib/project-service');
      const projectService = new ProjectService(WORKSPACE_ROOT);
      const oldName = toolCall.arguments.old_name as string;
      const newName = toolCall.arguments.new_name as string;

      if (!oldName || !newName) {
        throw new Error('Both old_name and new_name are required');
      }

      const result = await projectService.renameProject(oldName, newName);
      console.log(`   📝 Project renamed: ${oldName} -> ${result.folder}`);

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: { success: true, message: `Renamed project "${oldName}" to "${result.folder}"`, project: result },
      };
    } catch (err) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Project rename failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  }

  // PDF generation (Batch 5) — now with embedded image support
  if (toolCall.name === 'workspace_generate_pdf') {
    try {
      const { PDFService } = await import('@/lib/pdf-service');
      const ws = new WorkspaceService(WORKSPACE_ROOT, WORKSPACE_MAX_FILE_SIZE_KB * 10, ['.pdf', ...WORKSPACE_ALLOWED_EXTENSIONS, ...WORKSPACE_IMAGE_EXTENSIONS]);
      const sourcePath = toolCall.arguments.source_path as string | undefined;
      const content = toolCall.arguments.content as string | undefined;
      const outputPath = toolCall.arguments.output_path as string;
      const title = toolCall.arguments.title as string | undefined;
      const rawImages = toolCall.arguments.images as Array<{ path: string; width?: number; caption?: string }> | undefined;

      let markdown: string;
      if (sourcePath) {
        markdown = await ws.readFile(sourcePath);
      } else if (content) {
        markdown = content;
      } else {
        throw new Error('Either source_path or content is required');
      }

      // Resolve image paths from workspace-relative to absolute
      const resolvedImages = rawImages?.map(img => ({
        path: ws.resolveSafe(img.path),
        width: img.width,
        caption: img.caption,
      }));

      const resolvedOutput = ws.resolveSafe(outputPath);
      await PDFService.markdownToPDF(markdown, resolvedOutput, title, {
        images: resolvedImages,
        workspaceRoot: WORKSPACE_ROOT,
      });

      if (sessionFileCount.created < sessionFileCount.maxAllowed) {
        sessionFileCount.created++;
      }
      send({ type: 'file_created', path: outputPath });
      console.log(`   📄 PDF generated: ${outputPath}`);

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: { success: true, message: `PDF generated at ${outputPath}`, path: outputPath },
      };
    } catch (err) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `PDF generation failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  }

  // Scrape page for image URLs
  if (toolCall.name === 'scrape_page_images') {
    try {
      const pageUrl = toolCall.arguments.url as string;
      const minWidth = (toolCall.arguments.min_width as number) || 100;
      const limit = (toolCall.arguments.limit as number) || 20;

      // Validate URL
      const parsedPageUrl = new URL(pageUrl);
      if (!['http:', 'https:'].includes(parsedPageUrl.protocol)) {
        throw new Error('Only http/https URLs are allowed');
      }

      // Fetch the page HTML with browser-like headers
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      const response = await fetch(pageUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const html = await response.text();
      const imageUrls: string[] = [];
      const seen = new Set<string>();

      // Helper: resolve relative URLs and deduplicate
      function addUrl(src: string) {
        if (!src || src.startsWith('data:')) return;
        try {
          const resolved = new URL(src, pageUrl).href;
          // Skip tiny tracking pixels and common non-content patterns
          if (seen.has(resolved)) return;
          if (/\b(pixel|tracking|beacon|spacer|blank|1x1)\b/i.test(resolved)) return;
          seen.add(resolved);
          imageUrls.push(resolved);
        } catch { /* invalid URL */ }
      }

      // 1. Extract <img src="..."> and <img data-src="..." (lazy loading)>
      const imgSrcRegex = /<img\s[^>]*?(?:src|data-src|data-lazy-src)\s*=\s*["']([^"']+)["'][^>]*>/gi;
      let match;
      while ((match = imgSrcRegex.exec(html)) !== null) {
        addUrl(match[1]);
      }

      // 2. Extract srcset URLs (responsive images — pick the largest)
      const srcsetRegex = /srcset\s*=\s*["']([^"']+)["']/gi;
      while ((match = srcsetRegex.exec(html)) !== null) {
        const entries = match[1].split(',').map(s => s.trim());
        for (const entry of entries) {
          const parts = entry.split(/\s+/);
          if (parts[0]) addUrl(parts[0]);
        }
      }

      // 3. Extract og:image and twitter:image meta tags
      const metaRegex = /<meta\s[^>]*?(?:property|name)\s*=\s*["'](?:og:image|twitter:image)["'][^>]*?content\s*=\s*["']([^"']+)["'][^>]*>/gi;
      while ((match = metaRegex.exec(html)) !== null) {
        addUrl(match[1]);
      }
      // Also match reverse order: content before property
      const metaRegex2 = /<meta\s[^>]*?content\s*=\s*["']([^"']+)["'][^>]*?(?:property|name)\s*=\s*["'](?:og:image|twitter:image)["'][^>]*>/gi;
      while ((match = metaRegex2.exec(html)) !== null) {
        addUrl(match[1]);
      }

      // 4. Extract background-image CSS urls
      const bgRegex = /background(?:-image)?\s*:\s*url\(["']?([^"')]+)["']?\)/gi;
      while ((match = bgRegex.exec(html)) !== null) {
        addUrl(match[1]);
      }

      // 5. Extract JSON-LD product images
      const jsonLdRegex = /<script\s[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
      while ((match = jsonLdRegex.exec(html)) !== null) {
        try {
          const data = JSON.parse(match[1]);
          // Handle both single objects and arrays
          const items = Array.isArray(data) ? data : [data];
          for (const item of items) {
            if (item.image) {
              const imgs = Array.isArray(item.image) ? item.image : [item.image];
              for (const img of imgs) {
                if (typeof img === 'string') addUrl(img);
                else if (img?.url) addUrl(img.url);
              }
            }
          }
        } catch { /* invalid JSON-LD */ }
      }

      // Filter: attempt to guess dimensions from URL params and skip small images
      const filtered = imageUrls.filter(u => {
        // Check for dimension hints in the URL
        const widthMatch = u.match(/[?&](?:w|width)=(\d+)/i) || u.match(/(\d+)x\d+/);
        if (widthMatch) {
          const w = parseInt(widthMatch[1]);
          if (w < minWidth) return false;
        }
        // Skip common non-content image patterns
        if (/\.(svg|ico)$/i.test(u)) return false;
        return true;
      });

      const results = filtered.slice(0, limit);
      console.log(`   🔍 Scraped ${pageUrl}: found ${imageUrls.length} images, filtered to ${results.length}`);

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: {
          success: true,
          pageUrl,
          totalFound: imageUrls.length,
          returned: results.length,
          images: results.map((u, i) => {
            const pathname = new URL(u).pathname;
            const dotIdx = pathname.lastIndexOf('.');
            const ext = dotIdx >= 0 ? pathname.slice(dotIdx).toLowerCase() : '(unknown)';
            return { index: i, url: u, extension: ext };
          }),
        },
      };
    } catch (err) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Page scrape failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  }

  // Web image download
  if (toolCall.name === 'download_web_image') {
    try {
      const url = toolCall.arguments.url as string;
      const savePath = toolCall.arguments.save_path as string;
      const resizeMax = toolCall.arguments.resize_max as number | undefined;

      // Validate URL
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
          throw new Error('Only http/https URLs are allowed');
        }
      } catch {
        throw new Error(`Invalid URL: ${url}`);
      }

      if (sessionFileCount.created >= sessionFileCount.maxAllowed) {
        throw new Error(`Session file limit reached (${sessionFileCount.maxAllowed}). Cannot download more files.`);
      }

      // Fetch with timeout and browser-like headers to avoid 403 blocks
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': parsedUrl.origin + '/',
        },
      });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // Validate content type
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) {
        throw new Error(`Not an image: content-type is "${contentType}"`);
      }

      // Read body and enforce 10MB limit
      const arrayBuffer = await response.arrayBuffer();
      const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
      if (arrayBuffer.byteLength > MAX_IMAGE_BYTES) {
        throw new Error(`Image too large (${(arrayBuffer.byteLength / 1024 / 1024).toFixed(1)}MB). Maximum: 10MB`);
      }

      let imageBuffer: Buffer = Buffer.from(arrayBuffer) as Buffer;
      let finalSavePath = savePath;

      // Auto-convert WebP to PNG (better compatibility with PDFs, viewers, etc.)
      const isWebP = contentType.includes('webp') || url.toLowerCase().endsWith('.webp');
      if (isWebP) {
        try {
          const sharp = (await import('sharp')).default;
          imageBuffer = await sharp(imageBuffer).png().toBuffer();
          // Update save path extension to .png if it was .webp
          if (finalSavePath.toLowerCase().endsWith('.webp')) {
            finalSavePath = finalSavePath.replace(/\.webp$/i, '.png');
          } else if (!finalSavePath.toLowerCase().endsWith('.png')) {
            finalSavePath = finalSavePath + '.png';
          }
          console.log(`   🔄 Converted WebP to PNG (${(arrayBuffer.byteLength / 1024).toFixed(0)}KB → ${(imageBuffer.length / 1024).toFixed(0)}KB)`);
        } catch (convertErr) {
          console.warn(`   ⚠️ WebP conversion failed, saving as-is:`, convertErr);
        }
      }

      // Optional resize via sharp
      if (resizeMax && resizeMax > 0) {
        try {
          const sharp = (await import('sharp')).default;
          imageBuffer = await sharp(imageBuffer)
            .resize(resizeMax, resizeMax, { fit: 'inside', withoutEnlargement: true })
            .toBuffer();
        } catch (resizeErr) {
          console.warn(`   ⚠️ Image resize failed, saving original:`, resizeErr);
        }
      }

      // Write to workspace with image extensions allowed
      const ws = new WorkspaceService(WORKSPACE_ROOT, MAX_IMAGE_BYTES / 1024, [...WORKSPACE_ALLOWED_EXTENSIONS, ...WORKSPACE_IMAGE_EXTENSIONS]);
      const result = await ws.writeFileBuffer(finalSavePath, imageBuffer, [...WORKSPACE_ALLOWED_EXTENSIONS, ...WORKSPACE_IMAGE_EXTENSIONS]);
      sessionFileCount.created++;
      send({ type: 'file_created', path: finalSavePath });
      const webpNote = isWebP ? ' (converted from WebP to PNG)' : '';
      console.log(`   🖼️ Downloaded image: ${url} → ${finalSavePath} (${(imageBuffer.length / 1024).toFixed(1)}KB)${webpNote}`);

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: { success: true, message: result + webpNote, path: finalSavePath, sizeKB: Math.round(imageBuffer.length / 1024) },
      };
    } catch (err) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Image download failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  }

  // PDF text extraction
  if (toolCall.name === 'workspace_read_pdf') {
    try {
      const pdfPath = toolCall.arguments.path as string;
      const pageStart = toolCall.arguments.page_start as number | undefined;
      const pageEnd = toolCall.arguments.page_end as number | undefined;

      const allExtensions = [...WORKSPACE_ALLOWED_EXTENSIONS, ...WORKSPACE_IMAGE_EXTENSIONS, ...WORKSPACE_DOWNLOAD_EXTENSIONS];
      const ws = new WorkspaceService(WORKSPACE_ROOT, WORKSPACE_MAX_FILE_SIZE_KB, allExtensions);
      const text = await ws.readPdfText(pdfPath, { start: pageStart, end: pageEnd });

      console.log(`   📄 PDF read: ${pdfPath} (${text.length} chars${pageStart ? `, pages ${pageStart}-${pageEnd || 'end'}` : ''})`);

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: { success: true, content: text, charCount: text.length },
      };
    } catch (err) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `PDF read failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  }

  // General web file download
  if (toolCall.name === 'download_web_file') {
    try {
      const url = toolCall.arguments.url as string;
      const savePath = toolCall.arguments.save_path as string;

      // Validate URL
      try {
        const parsedUrl = new URL(url);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
          throw new Error('Only http/https URLs are allowed');
        }
      } catch {
        throw new Error(`Invalid URL: ${url}`);
      }

      if (sessionFileCount.created >= sessionFileCount.maxAllowed) {
        throw new Error(`Session file limit reached (${sessionFileCount.maxAllowed}). Cannot download more files.`);
      }

      // Fetch with timeout and browser-like headers
      const fileController = new AbortController();
      const timeout = setTimeout(() => fileController.abort(), 60000); // 60s for larger files
      const fileParsedUrl = new URL(url);
      const response = await fetch(url, {
        signal: fileController.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': fileParsedUrl.origin + '/',
        },
      });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // Read body and enforce 50MB limit
      const arrayBuffer = await response.arrayBuffer();
      const MAX_FILE_BYTES = 50 * 1024 * 1024;
      if (arrayBuffer.byteLength > MAX_FILE_BYTES) {
        throw new Error(`File too large (${(arrayBuffer.byteLength / 1024 / 1024).toFixed(1)}MB). Maximum: 50MB`);
      }

      const fileBuffer = Buffer.from(arrayBuffer) as Buffer;
      const allDownloadExtensions = [...WORKSPACE_ALLOWED_EXTENSIONS, ...WORKSPACE_IMAGE_EXTENSIONS, ...WORKSPACE_DOWNLOAD_EXTENSIONS];
      const ws = new WorkspaceService(WORKSPACE_ROOT, MAX_FILE_BYTES / 1024, allDownloadExtensions);
      const result = await ws.writeFileBuffer(savePath, fileBuffer, allDownloadExtensions);
      sessionFileCount.created++;
      send({ type: 'file_created', path: savePath });
      console.log(`   📥 Downloaded file: ${url} → ${savePath} (${(fileBuffer.length / 1024).toFixed(1)}KB)`);

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: { success: true, message: result, path: savePath, sizeKB: Math.round(fileBuffer.length / 1024) },
      };
    } catch (err) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `File download failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  }

  // Code sandbox: execute_code
  if (toolCall.name === 'execute_code') {
    try {
      const { CodeSandbox } = await import('@/lib/code-sandbox');
      const sandbox = new CodeSandbox(WORKSPACE_ROOT);
      const projectFolder = toolCall.arguments.project_folder as string;
      const language = toolCall.arguments.language as 'python' | 'node';
      const code = toolCall.arguments.code as string;
      const timeoutSeconds = toolCall.arguments.timeout_seconds as number | undefined;
      const timeoutMs = timeoutSeconds ? Math.min(timeoutSeconds * 1000, 120_000) : undefined;

      const result = language === 'python'
        ? await sandbox.executePython(projectFolder, code, timeoutMs)
        : await sandbox.executeNode(projectFolder, code, timeoutMs);

      console.log(`   🔧 execute_code (${language}): exit=${result.exitCode} timedOut=${result.timedOut} ${result.durationMs}ms`);

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: result,
      };
    } catch (err) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Code execution failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  }

  // Code sandbox: create_venv
  if (toolCall.name === 'create_venv') {
    try {
      const { CodeSandbox } = await import('@/lib/code-sandbox');
      const sandbox = new CodeSandbox(WORKSPACE_ROOT);
      const projectFolder = toolCall.arguments.project_folder as string;
      const runtime = toolCall.arguments.runtime as 'python' | 'node';

      const result = runtime === 'python'
        ? await sandbox.createPythonVenv(projectFolder)
        : await sandbox.initNodeProject(projectFolder);

      console.log(`   🔧 create_venv (${runtime}): exit=${result.exitCode} ${result.durationMs}ms`);

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: result,
      };
    } catch (err) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Environment creation failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  }

  // Code sandbox: install_package
  if (toolCall.name === 'install_package') {
    try {
      const { CodeSandbox } = await import('@/lib/code-sandbox');
      const sandbox = new CodeSandbox(WORKSPACE_ROOT);
      const projectFolder = toolCall.arguments.project_folder as string;
      const runtime = toolCall.arguments.runtime as 'python' | 'node';
      const packages = toolCall.arguments.packages as string[];

      const result = runtime === 'python'
        ? await sandbox.pipInstall(projectFolder, packages)
        : await sandbox.npmInstall(projectFolder, packages);

      console.log(`   📦 install_package (${runtime}): ${packages.join(', ')} exit=${result.exitCode} ${result.durationMs}ms`);

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: result,
      };
    } catch (err) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Package install failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  }

  // Code sandbox: run_command
  if (toolCall.name === 'run_command') {
    try {
      const { CodeSandbox } = await import('@/lib/code-sandbox');
      const sandbox = new CodeSandbox(WORKSPACE_ROOT);
      const projectFolder = toolCall.arguments.project_folder as string;
      const command = toolCall.arguments.command as string;
      const timeoutSeconds = toolCall.arguments.timeout_seconds as number | undefined;
      const timeoutMs = timeoutSeconds ? Math.min(timeoutSeconds * 1000, 120_000) : undefined;

      const result = await sandbox.runCommand(projectFolder, command, timeoutMs);

      console.log(`   🔧 run_command: "${command.slice(0, 60)}" exit=${result.exitCode} ${result.durationMs}ms`);

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: result,
      };
    } catch (err) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Command execution failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  }

  // Proactive notification (Batch 5)
  if (toolCall.name === 'send_notification') {
    try {
      const notifMessage = toolCall.arguments.message as string;
      const rawAudio = toolCall.arguments.include_audio;
      const includeAudio = rawAudio === false || rawAudio === 'false' || rawAudio === 'False' ? false : true;
      const imageIds = Array.isArray(toolCall.arguments.image_ids) ? toolCall.arguments.image_ids as string[] : [];

      await prisma.notification.create({
        data: {
          choomId,
          message: notifMessage,
          includeAudio,
          imageIds: imageIds.length > 0 ? JSON.stringify(imageIds) : null,
        },
      });

      console.log(`   📨 Notification queued: "${notifMessage.slice(0, 60)}..." (images: ${imageIds.length})`);

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: { success: true, message: `Notification queued for delivery via Signal.${imageIds.length > 0 ? ` ${imageIds.length} image(s) attached.` : ''}` },
      };
    } catch (err) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Notification failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  }

  // Vision analysis (Optic)
  if (toolCall.name === 'analyze_image') {
    try {
      const visionProviderId = (settings?.vision as Record<string, unknown>)?.visionProviderId as string | undefined;
      let visionApiKey = (settings?.vision as Record<string, unknown>)?.apiKey as string | undefined;
      let visionEndpoint = (settings?.vision as Record<string, unknown>)?.endpoint as string || process.env.VISION_ENDPOINT || 'http://localhost:1234';
      // Resolve providers: prefer client-sent, fall back to bridge-config.json
      let visionProviders: LLMProviderConfig[] = (settings?.providers as LLMProviderConfig[]) || [];
      if (visionProviders.length === 0) {
        try {
          const fs = await import('fs');
          const path = await import('path');
          const bridgePath = path.join(process.cwd(), 'services', 'signal-bridge', 'bridge-config.json');
          if (fs.existsSync(bridgePath)) {
            const bridgeCfg = JSON.parse(fs.readFileSync(bridgePath, 'utf-8'));
            visionProviders = (bridgeCfg.providers || []) as LLMProviderConfig[];
          }
        } catch { /* ignore */ }
      }
      if (visionProviderId && visionProviders.length > 0) {
        const visionProvider = visionProviders.find(
          (p: LLMProviderConfig) => p.id === visionProviderId
        );
        if (visionProvider?.apiKey) {
          visionApiKey = visionProvider.apiKey;
        }
        if (visionProvider?.endpoint) {
          // Use provider endpoint — strip /v1 suffix since VisionService adds it
          visionEndpoint = visionProvider.endpoint.replace(/\/v1\/?$/, '');
        }
      }
      const rawVisionModel = (settings?.vision as Record<string, unknown>)?.model as string;
      const fallbackModel = ((settings?.llm as Record<string, unknown>)?.model as string) || defaultLLMSettings.model;
      const visionModel = (rawVisionModel && rawVisionModel !== 'vision-model')
        ? rawVisionModel
        : fallbackModel; // Fall back to LLM model (multimodal models support vision natively)
      const visionSettings: VisionSettings = {
        endpoint: visionEndpoint,
        model: visionModel,
        maxTokens: (settings?.vision as Record<string, unknown>)?.maxTokens as number || 1024,
        temperature: (settings?.vision as Record<string, unknown>)?.temperature as number || 0.3,
        apiKey: visionApiKey,
      };

      // Apply vision profile if available
      const userVisionProfiles = (settings?.visionProfiles as VisionModelProfile[]) || [];
      const visionProfile = findVisionProfile(visionModel, userVisionProfiles);
      let visionMaxDimension: number | undefined;
      let visionMaxSizeBytes: number | undefined;
      if (visionProfile) {
        if (visionProfile.maxTokens !== undefined) visionSettings.maxTokens = visionProfile.maxTokens;
        if (visionProfile.temperature !== undefined) visionSettings.temperature = visionProfile.temperature;
        visionMaxDimension = visionProfile.maxImageDimension;
        visionMaxSizeBytes = visionProfile.maxImageSizeBytes;
        console.log(`   👁️  Vision profile applied: "${visionProfile.label || visionProfile.modelId}" (maxDim=${visionMaxDimension}, maxSize=${visionMaxSizeBytes ? Math.round(visionMaxSizeBytes / 1024 / 1024) + 'MB' : 'default'})`);
      }

      // If image_id is provided, look up the generated image from the database
      let imageBase64 = toolCall.arguments.image_base64 as string | undefined;
      if (toolCall.arguments.image_id && !imageBase64) {
        try {
          const genImage = await prisma.generatedImage.findUnique({
            where: { id: toolCall.arguments.image_id as string },
          });
          if (genImage?.imageUrl) {
            // Extract base64 from data URL if present
            const dataUrl = genImage.imageUrl;
            if (dataUrl.startsWith('data:')) {
              imageBase64 = dataUrl.split(',')[1];
            } else {
              imageBase64 = dataUrl;
            }
            console.log(`   👁️  Loaded generated image ${toolCall.arguments.image_id} from DB for analysis`);
          } else {
            throw new Error(`Generated image ${toolCall.arguments.image_id} not found in database`);
          }
        } catch (dbErr) {
          throw new Error(`Failed to load generated image: ${dbErr instanceof Error ? dbErr.message : 'Unknown error'}`);
        }
      }

      const visionService = new VisionService({
        ...visionSettings,
        maxImageDimension: visionMaxDimension,
        maxImageSizeBytes: visionMaxSizeBytes,
      });
      const result = await visionService.analyzeImage({
        prompt: toolCall.arguments.prompt as string,
        imagePath: toolCall.arguments.image_path as string | undefined,
        imageUrl: toolCall.arguments.image_url as string | undefined,
        imageBase64: imageBase64,
        mimeType: toolCall.arguments.mime_type as string | undefined,
      }, WORKSPACE_ROOT);

      console.log(`   👁️  Vision analysis complete (${result.model}): ${result.analysis.slice(0, 100)}...`);

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: {
          success: true,
          analysis: result.analysis,
          model: result.model,
        },
      };
    } catch (err) {
      console.error('   ❌ Vision error:', err instanceof Error ? err.message : err);
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Vision analysis failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  }

  // Unknown tool
  return {
    toolCallId: toolCall.id,
    name: toolCall.name,
    result: null,
    error: `Tool ${toolCall.name} not implemented yet`,
  };
}

// ============================================================================
// Hardcoded tool documentation (original, used when USE_SKILL_DISPATCH=false)
// ============================================================================

function getHardcodedToolDocs(): string {
  return `## AVAILABLE TOOLS

You have access to the following tools:

**Memory Tools:**
- \`remember\` - Store new memories (facts, preferences, events). Use when the user shares something important.
- \`search_memories\` - Search memories using natural language. Use when recalling past information.
- \`get_memory_stats\` - Get memory statistics. Use when asked about memory status.
- \`get_recent_memories\` - Get recently stored memories.
- \`search_by_type\` - Search by category (fact, preference, event, conversation, task).
- \`search_by_tags\` - Search by specific tags.
- \`update_memory\` - Update an existing memory by ID.
- \`delete_memory\` - Delete a memory by ID.

**Image Generation:**
- \`generate_image\` - Generate an image using Stable Diffusion. Parameters:
  - \`prompt\`: Detailed description of the image
  - \`self_portrait\`: Set to TRUE when generating an image of yourself/your appearance (selfie, portrait, picture of you)
  - \`size\`: Optional size preset - "small" (768px), "medium" (1024px), "large" (1536px), "x-large" (1856px)
  - \`aspect\`: Optional aspect ratio - "portrait" (3:4), "portrait-tall" (9:16), "square" (1:1), "landscape" (16:9), "wide" (21:9)

**Weather:**
- \`get_weather\` - Get current weather conditions. Parameters:
  - \`location\`: (Optional) City name like "Denver, CO" or "Phoenix, AZ"
  - If omitted or empty, uses the user's home location (coordinates already configured)
  - For "here", "near me", "close by", "my area", or any vague/local reference: call with NO location parameter
  - Only pass a location for a specific different city. Small towns may not be recognized - use the nearest larger city
- \`get_weather_forecast\` - Get 5-day weather forecast. Parameters:
  - \`location\`: (Optional) City name - same rules as get_weather
  - \`days\`: Number of days (1-5, default 5)
  - Use when user asks about future weather ("tomorrow", "this week", "will it rain")
  - For current conditions, use \`get_weather\` instead

**Web Search:**
- \`web_search\` - Search the web for current information. Parameters:
  - \`query\`: The search query (required)
  - \`max_results\`: Maximum number of results (optional, default 5)

**Google Calendar:**
- \`get_calendar_events\` - Get calendar events. Parameters:
  - \`days_ahead\`: Number of days to look ahead (optional, default 7)
  - \`days_back\`: Number of days to look backward (optional). Use when user asks about past events.
  - \`query\`: Optional search filter to match event titles/descriptions
- \`create_calendar_event\` - Create a new calendar event. Parameters:
  - \`summary\`: Event title (required)
  - \`start_time\`: Start time in ISO format like "2026-02-10T14:00:00" (required)
  - \`end_time\`: End time in ISO format (optional, defaults to 1 hour after start)
  - \`description\`: Event notes (optional)
  - \`location\`: Event location (optional)
  - \`all_day\`: Set to true for all-day events (optional)
- \`update_calendar_event\` - Update an existing event. Get the event_id from get_calendar_events first.
- \`delete_calendar_event\` - Delete a calendar event. Parameters: \`event_id\` (required)

**Google Tasks:**
- \`list_task_lists\` - List all available Google Task list names.
- \`get_task_list\` - Get items from a task list. Parameters: \`list_name\` (required)
- \`add_to_task_list\` - Add an item to a task list. Parameters: \`list_name\`, \`item_title\` (required)
- \`remove_from_task_list\` - Remove an item. Parameters: \`list_name\`, \`item_title\` (required)

**Reminders:**
- \`create_reminder\` - Set a timed reminder delivered via Signal. Parameters: \`text\` (required), \`minutes_from_now\` or \`time\`
- \`get_reminders\` - Get all pending reminders. Parameters: \`date\` (optional)

**Google Sheets:**
- \`list_spreadsheets\` - List recent Google Sheets.
- \`create_spreadsheet\` - Create a new spreadsheet. Parameters: \`title\` (required), \`sheet_names\`, \`initial_data\`
- \`read_sheet\` - Read data. Parameters: \`spreadsheet_id\`, \`range\` (required)
- \`write_sheet\` - Write/overwrite data. Parameters: \`spreadsheet_id\`, \`range\`, \`values\` (required)
- \`append_to_sheet\` - Append rows. Parameters: \`spreadsheet_id\`, \`range\`, \`values\` (required)

**Google Docs:**
- \`list_documents\` - List recent Google Docs.
- \`create_document\` - Create a new Google Doc. Parameters: \`title\` (required), \`content\` (optional)
- \`read_document\` - Read text from a Google Doc. Parameters: \`document_id\` (required)
- \`append_to_document\` - Append text. Parameters: \`document_id\`, \`text\` (required)

**Google Drive:**
- \`list_drive_files\` - List files in Drive. Parameters: \`folder_id\` (optional), \`max_results\` (optional)
- \`search_drive\` - Search Drive files. Parameters: \`query\` (required)
- \`create_drive_folder\` - Create a Drive folder. Parameters: \`name\` (required)
- \`upload_to_drive\` - Upload workspace file to Drive. Parameters: \`workspace_path\` (required)
- \`download_from_drive\` - Download Drive file to workspace. Parameters: \`file_id\`, \`workspace_path\` (required)

**Workspace Tools:**
- \`workspace_write_file\` - Write/create a file. Parameters: \`path\`, \`content\` (required)
- \`workspace_read_file\` - Read a file. Parameters: \`path\` (required)
- \`workspace_list_files\` - List files. Parameters: \`path\` (optional)
- \`workspace_create_folder\` - Create a folder. Parameters: \`path\` (required)
- \`workspace_delete_file\` - Delete a file. Parameters: \`path\` (required)
- \`workspace_rename_project\` - Rename a project folder. Parameters: \`old_name\`, \`new_name\` (required)
- \`workspace_generate_pdf\` - Convert markdown to PDF. Parameters: \`output_path\` (required), \`source_path\` or \`content\`, \`title\`, \`images\`
- \`workspace_read_pdf\` - Extract text from PDF. Parameters: \`path\` (required), \`page_start\`, \`page_end\`
- \`scrape_page_images\` - Scrape image URLs from a webpage. Use FIRST to find real URLs. Parameters: \`url\` (required)
- \`download_web_image\` - Download image to workspace. Auto-converts WebP to PNG. Parameters: \`url\`, \`save_path\` (required)
- \`download_web_file\` - Download any file to workspace. Parameters: \`url\`, \`save_path\` (required)
Use workspace tools for writing reports, saving code, creating structured projects. Use underscores instead of spaces in folder names.

**Code Sandbox:**
- \`execute_code\` - Execute Python or Node.js code. Parameters: \`project_folder\`, \`language\`, \`code\` (required)
- \`create_venv\` - Create Python venv or npm init. Parameters: \`project_folder\`, \`runtime\` (required)
- \`install_package\` - Install pip/npm packages. Parameters: \`project_folder\`, \`runtime\`, \`packages\` (required)
- \`run_command\` - Run a shell command. Parameters: \`project_folder\`, \`command\` (required)

**Notifications:**
- \`send_notification\` - Send a Signal message notification. Parameters: \`message\` (required)

**Vision (Optic):**
- \`analyze_image\` - Analyze an image using vision LLM. Parameters: \`prompt\` (required), plus one of: \`image_path\`, \`image_url\`, \`image_base64\`, \`image_id\`

## WHEN TO USE TOOLS

1. "remember something" → \`remember\`
2. "do you remember..." → \`search_memories\`
3. Memory stats → \`get_memory_stats\`
4. Recent conversations → \`get_recent_memories\`
5. "forget this" → \`delete_memory\`
6. Image of yourself (selfie) → \`generate_image\` with \`self_portrait: true\`
7. General image → \`generate_image\` with \`self_portrait: false\`
8. Current weather → \`get_weather\` (use embedded data for local; tool for other locations)
9. Future weather → \`get_weather_forecast\`
10. Current events / "search for" → \`web_search\`
11. Calendar / schedule → \`get_calendar_events\`
12. Past calendar events → \`get_calendar_events\` with \`days_back\`
13. Task/shopping list → \`get_task_list\`
14. "add to list" → \`add_to_task_list\`
15. "remove from list" → \`remove_from_task_list\`
16. "remind me" → \`create_reminder\`
17. "what lists" → \`list_task_lists\`
18. Write report/file → workspace tools
19. Task complete notification → \`send_notification\`
20. Analyze image → \`analyze_image\`
21-23. Image analysis variants → \`analyze_image\` with appropriate source
24-25. Reminders → \`get_reminders\`
26-28. Calendar CRUD → \`create/update/delete_calendar_event\`
29-33. Sheets CRUD → sheets tools
34-36. Docs CRUD → docs tools
37-41. Drive operations → drive tools`;
}

// ============================================================================
// Skill-based tool dispatch (Phase 1)
// Used when USE_SKILL_DISPATCH=true
// ============================================================================

async function executeToolCallViaSkills(
  toolCall: ToolCall,
  ctx: ToolContext
): Promise<ToolResult> {
  const registry = getSkillRegistry();
  const skill = registry.getSkillForTool(toolCall.name);

  if (!skill) {
    return {
      toolCallId: toolCall.id,
      name: toolCall.name,
      result: null,
      error: `Unknown tool: ${toolCall.name}`,
    };
  }

  // Normalize parameter names: LLMs sometimes send camelCase (imageId, savePath)
  // instead of the snake_case defined in tool schemas (image_id, save_path).
  // Convert camelCase args to snake_case when a matching property exists in the definition.
  const toolDef = skill.toolDefinitions.find(t => t.name === toolCall.name);
  if (toolDef?.parameters?.properties) {
    const expectedProps = new Set(Object.keys(toolDef.parameters.properties as Record<string, unknown>));
    const normalized: Record<string, unknown> = {};
    let changed = false;
    for (const [key, value] of Object.entries(toolCall.arguments)) {
      const snakeKey = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
      if (snakeKey !== key && expectedProps.has(snakeKey) && toolCall.arguments[snakeKey] === undefined) {
        normalized[snakeKey] = value;
        changed = true;
      } else {
        normalized[key] = value;
      }
    }
    if (changed) {
      console.log(`   🔄 Normalized param names for ${toolCall.name}: ${Object.keys(toolCall.arguments).join(', ')} → ${Object.keys(normalized).join(', ')}`);
      toolCall.arguments = normalized;
    }
  }

  // NOTE: No pre-validation of required params here — handlers already validate
  // their own parameters and support aliases (e.g. path/file_path/filename).
  // Pre-validation was too aggressive: it rejected calls before handlers could
  // apply defaults or aliases, and the failures cascaded via brokenTools/consecutiveFailures.

  const handlerCtx: SkillHandlerContext = {
    memoryClient: ctx.memoryClient,
    memoryCompanionId: ctx.memoryCompanionId,
    weatherSettings: ctx.weatherSettings,
    settings: ctx.settings,
    imageGenSettings: ctx.imageGenSettings,
    choom: ctx.choom,
    choomId: ctx.choomId,
    chatId: ctx.chatId,
    message: ctx.message,
    send: ctx.send,
    sessionFileCount: ctx.sessionFileCount,
    skillDoc: skill.fullDoc,
    getReference: (fileName: string) => registry.getLevel3Reference(skill.metadata.name, fileName),
  };

  try {
    return await skill.handler.execute(toolCall, handlerCtx);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`   ❌ Skill handler error for ${toolCall.name}:`, errMsg);
    return {
      toolCallId: toolCall.id,
      name: toolCall.name,
      result: null,
      error: `Tool execution failed: ${errMsg}`,
    };
  }
}

/**
 * Build the progressive disclosure tool documentation for the system prompt.
 * Level 1: Always included (~100 tokens per skill, ~1,600 total)
 * Level 2: Injected for up to 3 relevant skills based on user message
 */
function buildSkillToolDocs(userMessage: string): string {
  const registry = getSkillRegistry();
  let docs = `## AVAILABLE SKILLS

You have access to the following tool categories:

${registry.getLevel1Summaries()}

Call tools via function calls. Each tool is described in the tools array provided to you.`;

  // Inject Level 2 docs for up to 3 most relevant skills
  const relevantSkills = registry.matchSkills(userMessage, 3);
  if (relevantSkills.length > 0) {
    docs += '\n\n## SKILL DETAILS\n';
    for (const skill of relevantSkills) {
      const l2 = registry.getLevel2Doc(skill.metadata.name);
      if (l2) {
        docs += `\n### ${skill.metadata.name}\n${l2}\n`;
      }
    }
  }

  return docs;
}

// ============================================================================
// Main POST handler
// ============================================================================

export async function POST(request: NextRequest) {
  const encoder = new TextEncoder();

  // Load skills on first request (idempotent)
  const skillDispatch = useSkillDispatch();
  if (skillDispatch) {
    loadCoreSkills();
    loadCustomSkills();
  }

  try {
    const body = await request.json();
    const { choomId, chatId, message, settings, isDelegation } = body;

    if (!choomId || !chatId || !message) {
      return new Response(
        JSON.stringify({ error: 'choomId, chatId, and message are required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Fetch choom and chat data
    const [choom, chat] = await Promise.all([
      prisma.choom.findUnique({ where: { id: choomId } }),
      prisma.chat.findUnique({
        where: { id: chatId },
        include: { messages: { orderBy: { createdAt: 'asc' }, take: 200 } },
      }),
    ]);

    if (!choom || !chat) {
      return new Response(
        JSON.stringify({ error: 'Choom or Chat not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Record GUI activity so heartbeat scheduler defers while we're chatting
    if (!isDelegation) {
      recordGuiActivity(choom.name);
    }

    // Save user message
    const userMessage = await prisma.message.create({
      data: {
        chatId,
        role: 'user',
        content: message,
      },
    });

    // Update chat title if needed
    if (!chat.title) {
      const title = message.slice(0, 30) + (message.length > 30 ? '...' : '');
      await prisma.chat.update({ where: { id: chatId }, data: { title } });
    }

    // Build LLM settings: Layer 1 (code defaults) -> Layer 2 (client/settings panel) -> Layer 3 (Choom overrides)
    const clientLLMSettings = settings?.llm || {};
    const llmSettings: LLMSettings = {
      ...defaultLLMSettings,
      ...clientLLMSettings,
      ...(choom.llmModel && { model: choom.llmModel }),
      ...(choom.llmEndpoint && { endpoint: choom.llmEndpoint }),
    };

    // Settings hierarchy trace
    console.log(`\n⚙️  Settings Hierarchy for "${choom.name}":`);
    console.log(`   Layer 1 (defaults): model=${defaultLLMSettings.model}, endpoint=${defaultLLMSettings.endpoint}`);
    console.log(`   Layer 2 (settings panel): model=${clientLLMSettings.model || '(not set)'}, endpoint=${clientLLMSettings.endpoint || '(not set)'}`);
    console.log(`   Layer 3 (Choom DB): llmModel=${choom.llmModel || '(not set)'}, llmEndpoint=${choom.llmEndpoint || '(not set)'}, llmProviderId=${choom.llmProviderId || '(not set)'}`);
    console.log(`   ✅ RESOLVED: model=${llmSettings.model}, endpoint=${llmSettings.endpoint}`);
    if (choom.imageSettings) {
      try {
        const imgSettings = JSON.parse(choom.imageSettings);
        console.log(`   🖼️  Choom Image Settings: general.checkpoint=${imgSettings?.general?.checkpoint || '(not set)'}, selfPortrait.checkpoint=${imgSettings?.selfPortrait?.checkpoint || '(not set)'}`);
      } catch { /* ignore parse errors */ }
    } else {
      console.log(`   🖼️  Choom Image Settings: (none configured)`);
    }

    // Get memory endpoint from client settings or use default
    const memoryEndpoint = settings?.memory?.endpoint || DEFAULT_MEMORY_ENDPOINT;

    let llmClient: { streamChat: LLMClient['streamChat'] } = new LLMClient(llmSettings);

    // Resolve providers: prefer client-sent, fall back to bridge-config.json
    let providers: LLMProviderConfig[] = (settings?.providers as LLMProviderConfig[]) || [];
    if (providers.length === 0) {
      try {
        const fs = await import('fs');
        const path = await import('path');
        const bridgePath = path.join(process.cwd(), 'services', 'signal-bridge', 'bridge-config.json');
        if (fs.existsSync(bridgePath)) {
          const bridgeCfg = JSON.parse(fs.readFileSync(bridgePath, 'utf-8'));
          providers = (bridgeCfg.providers || []) as LLMProviderConfig[];
          if (providers.length > 0) {
            console.log(`   📂 Loaded ${providers.length} providers from bridge-config.json (not sent by client)`);
          }
        }
      } catch { /* ignore */ }
    }
    // Layer 2b: Global provider override (if LLM settings have a provider selected)
    const globalProviderId = (clientLLMSettings as Record<string, unknown>)?.llmProviderId as string | undefined;
    if (globalProviderId && providers.length > 0) {
      const globalProvider = providers.find(
        (p: LLMProviderConfig) => p.id === globalProviderId
      );
      if (globalProvider && globalProvider.apiKey) {
        const providerSettings: LLMSettings = {
          ...llmSettings,
          endpoint: globalProvider.endpoint,
        };
        if (globalProvider.type === 'anthropic') {
          const { AnthropicClient } = await import('@/lib/anthropic-client');
          llmClient = new AnthropicClient(providerSettings, globalProvider.apiKey, globalProvider.endpoint);
          console.log(`   🔌 Layer 2b (global provider): ${globalProvider.name} (anthropic) model=${llmSettings.model}`);
        } else {
          llmClient = new LLMClient(providerSettings, globalProvider.apiKey);
          console.log(`   🔌 Layer 2b (global provider): ${globalProvider.name} (openai) model=${llmSettings.model}`);
        }
        llmSettings.endpoint = globalProvider.endpoint;
      }
    }

    // Layer 3b: Choom-level provider override (if Choom has a provider assigned)
    if (choom.llmProviderId && providers.length > 0) {
      const choomProvider = providers.find(
        (p: LLMProviderConfig) => p.id === choom.llmProviderId
      );
      if (choomProvider && choomProvider.apiKey) {
        const choomModel = choom.llmModel || choomProvider.models[0] || llmSettings.model;
        const providerSettings: LLMSettings = {
          ...llmSettings,
          endpoint: choomProvider.endpoint,
          model: choomModel,
        };

        if (choomProvider.type === 'anthropic') {
          const { AnthropicClient } = await import('@/lib/anthropic-client');
          llmClient = new AnthropicClient(providerSettings, choomProvider.apiKey, choomProvider.endpoint);
          console.log(`   🔌 Layer 3b (Choom provider): ${choomProvider.name} (anthropic) model=${choomModel}`);
        } else {
          llmClient = new LLMClient(providerSettings, choomProvider.apiKey);
          console.log(`   🔌 Layer 3b (Choom provider): ${choomProvider.name} (openai) model=${choomModel}`);
        }
        llmSettings.model = choomModel;
        llmSettings.endpoint = choomProvider.endpoint;
      }
    }
    const memoryClient = new MemoryClient(memoryEndpoint);

    // Use companionId for memory operations (falls back to choomId if not set)
    const memoryCompanionId = choom.companionId || choomId;

    // Build time context
    const timeContext = getTimeContext('America/Denver');
    const timeInfo = formatTimeContextForPrompt(timeContext);

    // Build weather context
    const weatherSettings: WeatherSettings = smartMerge(
      defaultWeatherSettings,
      settings?.weather as Partial<WeatherSettings> | undefined,
    );
    let weatherInfo = '';
    if (weatherSettings.apiKey) {
      try {
        const weatherService = new WeatherService(weatherSettings);
        const weather = await weatherService.getWeather();
        weatherInfo = '\n\n' + weatherService.formatWeatherForPrompt(weather);
        console.log(`   🌤️  Weather loaded: ${weather.temperature}°F ${weather.description} in ${weather.location}`);
      } catch (error) {
        console.error('   ⚠️  Weather fetch FAILED:', error instanceof Error ? error.message : 'Unknown error');
      }
    } else {
      console.log('   ⚠️  Weather skipped: no API key');
    }

    // Build Home Assistant context
    let homeAssistantInfo = '';
    const haSettings = settings?.homeAssistant as HomeAssistantSettings | undefined;
    if (haSettings?.baseUrl && haSettings?.accessToken && haSettings?.injectIntoPrompt) {
      try {
        const haService = new HomeAssistantService(haSettings);
        const summary = await haService.formatSummaryForPrompt();
        if (summary) {
          homeAssistantInfo = '\n\n' + summary;
          console.log(`   🏠 Home Assistant: injected sensor summary`);
        }
      } catch (error) {
        console.error('   ⚠️  Home Assistant fetch FAILED:', error instanceof Error ? error.message : 'Unknown error');
      }
    }

    // Build recent images context
    let recentImagesInfo = '';
    try {
      const recentImages = await prisma.generatedImage.findMany({
        where: { choomId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { id: true, prompt: true, createdAt: true },
      });
      if (recentImages.length > 0) {
        const lines = recentImages.map(img => {
          const ago = Math.round((Date.now() - img.createdAt.getTime()) / 60000);
          const timeStr = ago < 60 ? `${ago}m ago` : ago < 1440 ? `${Math.round(ago / 60)}h ago` : `${Math.round(ago / 1440)}d ago`;
          const shortPrompt = img.prompt.length > 80 ? img.prompt.slice(0, 77) + '...' : img.prompt;
          return `- "${shortPrompt}" — image_id="${img.id}" (${timeStr})`;
        });
        recentImagesInfo = `\n\n## RECENT GENERATED IMAGES\nTo analyze any of these, call analyze_image with the image_id.\n${lines.join('\n')}`;
        console.log(`   🖼️  Recent images: ${recentImages.length} injected`);
      }
    } catch (error) {
      console.error('   ⚠️  Recent images fetch FAILED:', error instanceof Error ? error.message : 'Unknown error');
    }

    // Build tool documentation section
    // When USE_SKILL_DISPATCH=true, uses progressive disclosure from skill registry
    // When false, uses the hardcoded tool documentation (original behavior)
    const toolDocs = skillDispatch
      ? buildSkillToolDocs(message)
      : getHardcodedToolDocs();

    // Build system prompt with explicit tool instructions
    const systemPrompt = `${choom.systemPrompt || 'You are a helpful AI assistant.'}

${timeInfo}${weatherInfo}${homeAssistantInfo}${recentImagesInfo}

## AGENTIC BEHAVIOR
You can call tools multiple times across multiple steps. After receiving tool results, you may:
- Call additional tools based on the results
- Retry a failed tool with corrected parameters
- Chain tools sequentially (e.g., list_task_lists → get_task_list, search memories → search web → write report)
- Reason about errors and try alternative approaches
- Call MULTIPLE tools in parallel in a single step when they don't depend on each other (e.g., multiple web_search calls at once)
When a tool fails, examine the error message and either retry with corrected params, try an alternative tool, or explain the failure. You do NOT need to complete everything in a single tool call.
Be efficient: batch independent tool calls together to minimize iteration count.

${toolDocs}

## IMPORTANT

- ALWAYS call tools immediately via function calls when a request requires them. Do NOT describe what you would do — just call the tool. For example, if asked to "review images in the project folder", call \`workspace_list_files\` right away, then call \`analyze_image\` for each image found. Never say "Let me check..." without actually calling the tool in the same response.
- When a task involves multiple files or images, process them all — call tools in sequence or parallel as needed.
- Use tools via function calls (the tools array), not by writing tool names in your response
- After using a tool, incorporate the results naturally into your response — do NOT echo or repeat raw tool output verbatim. Summarize results conversationally.
- When showing code to the user, ALWAYS wrap it in fenced markdown code blocks with the language specified (e.g. \`\`\`python ... \`\`\`). Never output bare code without fences.
- Do NOT repeat file contents, code, or command output multiple times. Show it once, then discuss it.
- Be conversational and friendly when discussing memories
- If a memory search returns no results, let the user know you don't have that memory stored yet
- When generating images, provide a detailed prompt describing what you will create
- CRITICAL: Never invent or fabricate information. If you don't know something, say so. If a tool returns no results, report that honestly. Never guess at calendar events, locations, or weather data.
- When sharing links to Google Sheets, Docs, Drive files, or calendar events, ALWAYS use the exact URL returned by the tool result. NEVER construct or guess URLs.
- When the user asks about "here" or "my location", use the configured weather coordinates (no need to search memories for location).
- Never include file system paths (like /home/..., /tmp/...) in your responses. Refer to files by their workspace-relative name only (e.g. "photos/sunset.png" not "/home/nuc1/choom-projects/MyProject/photos/sunset.png").

## TIME & WEATHER AWARENESS

- Use time-appropriate greetings (Good morning, Good afternoon, Good evening)
- Be aware of the current season when suggesting activities
- Consider weather when the user mentions outdoor activities (e.g., warn about high winds for drone flying)
- You already have the current time and weather - use this knowledge naturally without needing to call tools unless asked for specifics
- For local weather (home, here, my area): call \`get_weather\` with NO location parameter.
  Coordinates for the user's location are already configured — never pass the user's
  hometown as a location string.
- Only pass a location parameter when asking about a DIFFERENT city (e.g., "Denver, CO", "Phoenix, AZ").

## WEB SEARCH GUIDELINES

When presenting search results:
- Summarize the key findings in your own words
- Include relevant links as markdown: [Source Name](url) - these will be clickable for the user
- Mention the source names naturally (e.g., "According to TechCrunch..." or "BBC reports that...")
- Don't just list links - explain what you found and why it's relevant
- If multiple sources agree, synthesize the information rather than repeating it`;

    // Add choomDecides instructions if enabled for either mode
    const choomImageSettings = choom.imageSettings ? JSON.parse(choom.imageSettings) : null;
    let finalSystemPrompt = systemPrompt;
    if (choomImageSettings?.selfPortrait?.choomDecides || choomImageSettings?.general?.choomDecides) {
      finalSystemPrompt += `\n\n## IMAGE SIZE/ASPECT AUTONOMY\nWhen generating images, you should pick the most appropriate size and aspect ratio for the content. For example:
- Self-portraits: use "portrait" or "portrait-tall" aspect
- Landscapes/scenery: use "landscape" or "wide" aspect
- General art: use "medium" or "large" size with appropriate aspect
- Quick sketches: use "small" size
Always include both \`size\` and \`aspect\` parameters when calling generate_image.`;
    }

    // Select tool definitions based on dispatch mode
    let activeTools: ToolDefinition[] = skillDispatch ? getAllToolsFromSkills() : allTools;

    // Per-Choom tool filtering: if system prompt contains <!-- allowed_skills: ... -->, restrict tools
    // Also supports <!-- max_iterations: N --> to cap agentic loop iterations
    const allowedSkillsMatch = (choom.systemPrompt || '').match(/<!--\s*allowed_skills:\s*(.+?)\s*-->/);
    let choomMaxIterations = 0; // 0 = use default
    const maxIterMatch = (choom.systemPrompt || '').match(/<!--\s*max_iterations:\s*(\d+)\s*-->/);
    if (maxIterMatch) {
      choomMaxIterations = Math.min(25, Math.max(3, parseInt(maxIterMatch[1])));
    }
    if (allowedSkillsMatch && skillDispatch) {
      const allowedSkillNames = allowedSkillsMatch[1].split(',').map(s => s.trim());
      const registry = getSkillRegistry();
      const allowedToolNames = new Set<string>();
      for (const skillName of allowedSkillNames) {
        const skill = registry.getSkill(skillName);
        if (skill) {
          for (const toolDef of skill.toolDefinitions) {
            allowedToolNames.add(toolDef.name);
          }
        }
      }
      if (allowedToolNames.size > 0) {
        activeTools = activeTools.filter(t => allowedToolNames.has(t.name));
        console.log(`   🔒 Tool filter: ${allowedSkillNames.join(', ')} → ${activeTools.length} tools`);
      }
    }

    // Delegation mode: strip delegation + plan tools to prevent recursive delegation loops
    if (isDelegation) {
      const delegationTools = new Set([
        'delegate_to_choom', 'list_team', 'get_delegation_result',
        'create_plan', 'execute_plan', 'adjust_plan',
      ]);
      const before = activeTools.length;
      activeTools = activeTools.filter(t => !delegationTools.has(t.name));
      console.log(`   🔒 Delegation mode: stripped ${before - activeTools.length} delegation/plan tools → ${activeTools.length} tools`);
    }

    // Build raw history messages (before compaction)
    const historyMessages: ChatMessage[] = [];
    for (const msg of chat.messages) {
      if (msg.role === 'tool') continue;
      historyMessages.push({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      });
    }

    // Cross-turn compaction: summarize old messages if history exceeds token budget
    const compactionService = new CompactionService(llmSettings, 0.5);
    let compactionSummary = (chat as { compactionSummary?: string | null }).compactionSummary || null;
    let systemPromptWithSummary = finalSystemPrompt;

    // Build a non-streaming LLM client for summarization
    const summarizationClient = (() => {
      // Check if llmClient has a chat() method (LLMClient has it, AnthropicClient now has it too)
      if ('chat' in llmClient && typeof (llmClient as Record<string, unknown>).chat === 'function') {
        return llmClient as { chat: (messages: ChatMessage[], tools?: ToolDefinition[]) => Promise<{ content: string; toolCalls: unknown; finishReason: string }> };
      }
      // Fallback: create a plain LLMClient for summarization (local endpoint, no API key needed)
      return new LLMClient(llmSettings);
    })();

    let compactedHistory: ChatMessage[] = historyMessages;
    let compactionWasPerformed = false;
    let compactionStats = { messagesDropped: 0, tokensBefore: 0, tokensAfter: 0 };

    if (historyMessages.length > 0) {
      try {
        const compactionResult = await compactionService.compactCrossTurn(
          finalSystemPrompt, activeTools, historyMessages, compactionSummary, summarizationClient
        );

        if (compactionResult.summaryUpdated) {
          compactionSummary = compactionResult.newSummary;
          // Persist updated summary to DB
          await prisma.chat.update({
            where: { id: chatId },
            data: { compactionSummary: compactionResult.newSummary },
          });
          console.log(`   🗜️  Compaction: ${compactionResult.messagesDropped} msgs folded into summary (~${compactionResult.tokensBeforeCompaction.toLocaleString()} → ~${compactionResult.tokensAfterCompaction.toLocaleString()} tokens)`);
          serverLog(choomId, chatId, 'info', 'system', 'Context Compaction',
            `${compactionResult.messagesDropped} messages summarized`,
            { tokensBefore: compactionResult.tokensBeforeCompaction, tokensAfter: compactionResult.tokensAfterCompaction,
              messagesDropped: compactionResult.messagesDropped });
        }

        // Inject summary into system prompt if we have one
        if (compactionSummary) {
          systemPromptWithSummary = finalSystemPrompt + `\n\n## PREVIOUS CONVERSATION SUMMARY\n${compactionSummary}`;
        }

        compactedHistory = compactionResult.messages;
        compactionWasPerformed = compactionResult.summaryUpdated;
        compactionStats = {
          messagesDropped: compactionResult.messagesDropped,
          tokensBefore: compactionResult.tokensBeforeCompaction,
          tokensAfter: compactionResult.tokensAfterCompaction,
        };
      } catch (compactErr) {
        console.warn('   ⚠️  Cross-turn compaction failed, using full history:', compactErr instanceof Error ? compactErr.message : compactErr);
      }
    }

    const currentMessages: ChatMessage[] = [
      { role: 'system', content: systemPromptWithSummary },
      ...compactedHistory,
    ];

    // Pre-detect project from user message or recent chat history (FIRST, before image injection)
    // Used for: (1) injecting exact folder name so LLM doesn't create duplicates,
    //           (2) applying per-project iteration limits (e.g. 100 instead of 25)
    //           (3) scoping image pre-injection to only the detected project folder
    let enrichedMessage = message;
    let detectedProject: { folder: string; metadata: { maxIterations?: number; name?: string; llmProviderId?: string; llmModel?: string; assignedChoom?: string } } | null = null;
    try {
      const projectService = new ProjectService(WORKSPACE_ROOT);
      const allProjects = await projectService.listProjects();
      const msgLowerForProject = message.toLowerCase().replace(/[_\s]+/g, ' ');

      // Helper: find matching projects in text, preferring longest (most specific) match
      const findBestMatch = (text: string): typeof detectedProject => {
        const matches: typeof allProjects = [];
        for (const proj of allProjects) {
          const folderNorm = proj.folder.toLowerCase().replace(/[_\s]+/g, ' ');
          const metaNameNorm = (proj.metadata.name || '').toLowerCase().replace(/[_\s]+/g, ' ');
          if ((folderNorm.length >= 4 && text.includes(folderNorm)) ||
              (metaNameNorm.length >= 4 && text.includes(metaNameNorm))) {
            matches.push(proj);
          }
        }
        if (matches.length === 0) return null;
        // Priority: (1) assigned to current Choom, (2) longest folder name, (3) has maxIterations
        const choomName = choom.name.toLowerCase();
        matches.sort((a, b) => {
          // Strongly prefer projects assigned to the current Choom
          const aAssigned = (a.metadata.assignedChoom || '').toLowerCase() === choomName ? 1 : 0;
          const bAssigned = (b.metadata.assignedChoom || '').toLowerCase() === choomName ? 1 : 0;
          if (aAssigned !== bAssigned) return bAssigned - aAssigned;
          // Then prefer longest folder name (most specific: "selfies_lissa" beats "selfies")
          const lenDiff = b.folder.length - a.folder.length;
          if (lenDiff !== 0) return lenDiff;
          const aHasIter = a.metadata.maxIterations && a.metadata.maxIterations > 0 ? 1 : 0;
          const bHasIter = b.metadata.maxIterations && b.metadata.maxIterations > 0 ? 1 : 0;
          return bHasIter - aHasIter;
        });
        return matches[0];
      };

      // First: check current message for project name
      detectedProject = findBestMatch(msgLowerForProject);

      // Second: if not in current message (e.g. user said "continue"),
      // scan recent chat history for the most recently referenced project
      if (!detectedProject && chat.messages.length > 0) {
        const recentMessages = chat.messages.slice(-10).reverse();
        for (const msg of recentMessages) {
          const msgContent = (msg.content || '').toLowerCase().replace(/[_\s]+/g, ' ');
          detectedProject = findBestMatch(msgContent);
          if (detectedProject) break;
        }
      }

      // Inject project context so LLM uses the exact folder name
      if (detectedProject) {
        const projMaxIter = detectedProject.metadata.maxIterations || MAX_ITERATIONS;
        enrichedMessage += `\n\n[System: Active project: "${detectedProject.folder}" (${projMaxIter} thinking rounds available). Use this EXACT folder name for all workspace file operations. Do NOT create a new folder with different casing or naming.]`;
        // Also update system prompt with the correct iteration limit
        currentMessages[0].content += `\nYou have ${projMaxIter} thinking rounds available. Each round can include multiple parallel tool calls — calling 5 tools in one round only uses 1 round, not 5. Do not stop early thinking you are running out of rounds.`;
        console.log(`   📂 Project "${detectedProject.folder}" detected — injecting context (maxIterations: ${projMaxIter})`);
      } else {
        // No project detected — use default limit
        currentMessages[0].content += `\nYou have ${MAX_ITERATIONS} thinking rounds available. Each round can include multiple parallel tool calls — calling 5 tools in one round only uses 1 round, not 5. Do not stop early thinking you are running out of rounds.`;
      }
    } catch { /* ignore project detection errors */ }

    // Pre-process: detect workspace/file requests and inject listing context
    // Scoped to detected project folder when available (avoids flooding context with unrelated images)
    const msgLower = message.toLowerCase();
    const mentionsImages = /\b(image|images|photo|photos|picture|pictures|jpg|jpeg|png|screenshot)\b/.test(msgLower);
    const mentionsWorkspace = /\b(project|folder|workspace|directory|files?)\b/.test(msgLower);
    const mentionsReview = /\b(review|analyze|look at|check|examine|describe|inspect|see|show)\b/.test(msgLower);
    const mentionsList = /\b(list|what'?s in|contents?|show me|what do i have|what files|what'?s there|empty|anything in)\b/.test(msgLower);

    if (mentionsWorkspace && (mentionsImages || mentionsReview || mentionsList)) {
      try {
        const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
        const ws = new WorkspaceService(WORKSPACE_ROOT, WORKSPACE_MAX_FILE_SIZE_KB, WORKSPACE_ALLOWED_EXTENSIONS);

        // Scope scanning to detected project folder, or scan all top-level dirs
        const scanDirs: string[] = detectedProject ? [detectedProject.folder] : [];
        const allFilePaths: string[] = [];
        const imagePaths: string[] = [];

        if (scanDirs.length === 0) {
          // No project detected — scan top-level to find all dirs
          const topLevel = await ws.listFiles('');
          for (const entry of topLevel) {
            if (entry.type === 'directory') scanDirs.push(entry.name);
            else if (entry.type === 'file') {
              allFilePaths.push(`📄 ${entry.name} (${entry.size} bytes)`);
              if (imageExts.some(ext => entry.name.toLowerCase().endsWith(ext))) {
                imagePaths.push(entry.name);
              }
            }
          }
        }

        for (const dir of scanDirs) {
          allFilePaths.push(`📁 ${dir}/`);
          const subFiles = await ws.listFiles(dir);
          for (const f of subFiles) {
            if (f.type === 'file') {
              allFilePaths.push(`  📄 ${dir}/${f.name} (${f.size} bytes)`);
              if (imageExts.some(ext => f.name.toLowerCase().endsWith(ext))) {
                imagePaths.push(`${dir}/${f.name}`);
              }
            } else if (f.type === 'directory') {
              allFilePaths.push(`  📁 ${dir}/${f.name}/`);
            }
          }
        }

        if (mentionsImages && imagePaths.length > 0) {
          // Image-specific: inject image paths with analyze_image instructions
          const fileList = imagePaths.map(p => `- ${p}`).join('\n');
          enrichedMessage = `${enrichedMessage}\n\n[System: Found ${imagePaths.length} image(s) in ${detectedProject ? `project "${detectedProject.folder}"` : 'workspace'}:\n${fileList}\nUse the analyze_image tool with image_path for each image listed above.]`;
          console.log(`   🖼️  Pre-injected ${imagePaths.length} workspace image paths into message${detectedProject ? ` (scoped to ${detectedProject.folder})` : ''}`);
        } else if (allFilePaths.length > 0) {
          // General listing: inject workspace tree
          const tree = allFilePaths.join('\n');
          enrichedMessage = `${enrichedMessage}\n\n[System: Current ${detectedProject ? `project "${detectedProject.folder}"` : 'workspace'} contents:\n${tree}\n]`;
          console.log(`   📂  Pre-injected workspace listing (${allFilePaths.length} entries) into message`);
        }
      } catch (err) {
        console.warn('   ⚠️  Failed to pre-list workspace files:', err);
      }
    }

    // Layer 4: Per-project LLM provider override
    if (detectedProject?.metadata?.llmProviderId && providers.length > 0) {
      const provider = providers.find(
        (p: LLMProviderConfig) => p.id === detectedProject!.metadata.llmProviderId
      );
      if (provider && provider.apiKey) {
        const projectModel = detectedProject.metadata.llmModel || provider.models[0] || llmSettings.model;
        const providerSettings: LLMSettings = {
          ...llmSettings,
          endpoint: provider.endpoint,
          model: projectModel,
        };

        if (provider.type === 'anthropic') {
          const { AnthropicClient } = await import('@/lib/anthropic-client');
          llmClient = new AnthropicClient(providerSettings, provider.apiKey, provider.endpoint);
          console.log(`   🔌 Layer 4 (project provider): ${provider.name} (anthropic) model=${projectModel}`);
        } else {
          // OpenAI-compatible with API key
          llmClient = new LLMClient(providerSettings, provider.apiKey);
          console.log(`   🔌 Layer 4 (project provider): ${provider.name} (openai) model=${projectModel}`);
        }
        llmSettings.model = projectModel;
        llmSettings.endpoint = provider.endpoint;
      }
    }

    // Profile application: apply per-model parameter profile if resolved model differs from global default
    const globalModel = (clientLLMSettings as Record<string, unknown>)?.model as string || defaultLLMSettings.model;
    if (llmSettings.model !== globalModel) {
      const userProfiles = (settings?.modelProfiles as LLMModelProfile[]) || [];
      const profile = findLLMProfile(llmSettings.model, userProfiles);
      if (profile) {
        // Apply profile params to llmSettings (only fields that are defined in the profile)
        if (profile.temperature !== undefined) llmSettings.temperature = profile.temperature;
        if (profile.topP !== undefined) llmSettings.topP = profile.topP;
        if (profile.maxTokens !== undefined) llmSettings.maxTokens = profile.maxTokens;
        if (profile.contextLength !== undefined) llmSettings.contextLength = profile.contextLength;
        if (profile.frequencyPenalty !== undefined) llmSettings.frequencyPenalty = profile.frequencyPenalty;
        if (profile.presencePenalty !== undefined) llmSettings.presencePenalty = profile.presencePenalty;
        if (profile.topK !== undefined) llmSettings.topK = profile.topK;
        if (profile.repetitionPenalty !== undefined) llmSettings.repetitionPenalty = profile.repetitionPenalty;
        if (profile.enableThinking !== undefined) llmSettings.enableThinking = profile.enableThinking;

        // Reconstruct llmClient with updated settings
        // Re-check which provider type is active to use the right client class
        const activeProviderId = choom.llmProviderId
          || detectedProject?.metadata?.llmProviderId
          || globalProviderId;
        const activeProvider = activeProviderId && providers.length > 0
          ? providers.find((p: LLMProviderConfig) => p.id === activeProviderId)
          : null;

        if (activeProvider?.type === 'anthropic' && activeProvider.apiKey) {
          const { AnthropicClient } = await import('@/lib/anthropic-client');
          llmClient = new AnthropicClient(llmSettings, activeProvider.apiKey, activeProvider.endpoint);
        } else if (activeProvider?.apiKey) {
          llmClient = new LLMClient(llmSettings, activeProvider.apiKey);
        } else {
          llmClient = new LLMClient(llmSettings);
        }

        console.log(`   📋 Model profile applied: "${profile.label || profile.modelId}" (temp=${profile.temperature}, topP=${profile.topP}, maxTokens=${profile.maxTokens}${profile.topK !== undefined ? `, topK=${profile.topK}` : ''}${profile.enableThinking !== undefined ? `, thinking=${profile.enableThinking}` : ''})`);
      }
    }

    // Add current user message
    currentMessages.push({ role: 'user', content: enrichedMessage });

    // Create streaming response
    const stream = new ReadableStream({
      async start(controller) {
        let streamClosed = false;
        const send = (data: Record<string, unknown>) => {
          if (streamClosed) return; // Silently skip if controller already closed (e.g., aborted delegation)
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          } catch {
            streamClosed = true; // Mark closed so subsequent sends skip silently
          }
        };

        let fullContent = '';
        let allToolCalls: ToolCall[] = [];
        let allToolResults: ToolResult[] = [];
        const sessionFileCount = { created: 0, maxAllowed: WORKSPACE_MAX_FILES_PER_SESSION };
        let maxIterations = MAX_ITERATIONS;
        let projectIterationLimitApplied = false;

        // Apply per-Choom iteration limit (from <!-- max_iterations: N --> in system prompt)
        if (choomMaxIterations > 0) {
          maxIterations = choomMaxIterations;
          console.log(`   🔒 [${choom.name}] maxIterations → ${maxIterations} (from system prompt directive)`);
        }

        // Delegation mode: cap iterations to prevent sub-tasks from running too long
        if (isDelegation) {
          maxIterations = Math.min(maxIterations, 6);
          console.log(`   🔒 [${choom.name}] Delegation mode: maxIterations capped at ${maxIterations}`);
        }

        // Apply per-project iteration limit from pre-detected project (detected above from message or chat history)
        if (detectedProject?.metadata?.maxIterations && detectedProject.metadata.maxIterations > 0) {
          maxIterations = detectedProject.metadata.maxIterations;
          projectIterationLimitApplied = true;
          console.log(`   📂 Project "${detectedProject.folder}": maxIterations → ${maxIterations}`);
        }

        // Build tool context
        const ctx: ToolContext = {
          memoryClient,
          memoryCompanionId,
          weatherSettings,
          settings: settings || {},
          imageGenSettings: smartMerge(
            defaultImageGenSettings,
            settings?.imageGen as Partial<ImageGenSettings> | undefined,
          ),
          choom: choom as unknown as Record<string, unknown>,
          choomId,
          chatId,
          message,
          send,
          sessionFileCount,
        };

        try {
          const requestStartTime = Date.now();
          const initialMsgContent = currentMessages.map(m => m.content).join('');
          const approxInitialTokens = Math.ceil(initialMsgContent.length / 4);
          console.log(`\n💬 Chat Request [${choom.name}] | ${currentMessages.length} msgs | ~${approxInitialTokens.toLocaleString()} tokens`);
          serverLog(choomId, chatId, 'info', 'llm', 'LLM Request', `${llmSettings.model}: ${message.slice(0, 100)}`,
            { model: llmSettings.model, endpoint: llmSettings.endpoint, userMessage: message, messageCount: currentMessages.length, approxTokens: approxInitialTokens });

          // Send compaction event to UI if compaction was performed
          if (compactionWasPerformed) {
            send({ type: 'compaction', messagesDropped: compactionStats.messagesDropped,
                   tokensBefore: compactionStats.tokensBefore, tokensAfter: compactionStats.tokensAfter });
          }

          // ================================================================
          // PLANNER — for multi-step requests, create and execute a plan
          // ================================================================
          let imageGenCount = 0; // Track images generated across plan + loop (cap at 3)
          let planExecuted = false;
          let planFullySucceeded = false;
          if (skillDispatch && !isDelegation && isMultiStepRequest(message)) {
            try {
              console.log(`   📋 Multi-step request detected — creating plan...`);
              const registry = getSkillRegistry();
              const plan = await createPlan(currentMessages, registry, llmClient, activeTools);

              if (plan) {
                console.log(`   📋 Plan created: "${plan.goal}" (${plan.steps.length} steps)`);
                const watcher = new WatcherLoop();

                // Execute plan with progress streaming
                const planToolExecutor = async (toolCall: ToolCall, _iter: number): Promise<ToolResult> => {
                  // Enforce image gen cap across plan + agentic loop
                  if (toolCall.name === 'generate_image' && imageGenCount >= 3) {
                    const capped: ToolResult = {
                      toolCallId: toolCall.id, name: toolCall.name, result: null,
                      error: `Image generation limit reached (${imageGenCount}/3 this request). Skip this step.`,
                    };
                    send({ type: 'tool_call', toolCall });
                    send({ type: 'tool_result', toolResult: capped });
                    return capped;
                  }

                  // Send tool call event
                  send({ type: 'tool_call', toolCall });
                  serverLog(choomId, chatId, 'info', 'system', `Plan Tool: ${toolCall.name}`,
                    `Arguments: ${JSON.stringify(toolCall.arguments).slice(0, 200)}`,
                    { toolName: toolCall.name, arguments: toolCall.arguments });

                  const result = skillDispatch
                    ? await executeToolCallViaSkills(toolCall, ctx)
                    : await executeToolCall(toolCall, ctx);

                  // Track image gen count
                  if (toolCall.name === 'generate_image' && !result.error) {
                    imageGenCount++;
                  }

                  // Track in allToolCalls/allToolResults for DB save
                  allToolCalls.push(toolCall);
                  allToolResults.push(result);

                  send({ type: 'tool_result', toolResult: result });
                  return result;
                };

                const planResult = await executePlan(plan, planToolExecutor, watcher, send);
                // Only mark plan as "executed" if it actually succeeded at something.
                // A completely failed plan should let the model recover via the agentic loop.
                planExecuted = planResult.succeeded > 0;
                planFullySucceeded = planResult.failed === 0 && planResult.succeeded > 0;

                // Inject plan summary into conversation context so the LLM can reference it
                const planSummaryText = summarizePlan(plan);
                const stepSummaries = plan.steps.map(s =>
                  `- ${s.description}: ${s.status}${s.result?.error ? ` (error: ${s.result.error})` : ''}`
                ).join('\n');

                currentMessages.push({
                  role: 'assistant',
                  content: `I executed a ${plan.steps.length}-step plan: "${plan.goal}"\n\n${stepSummaries}\n\n${planSummaryText}`,
                });

                fullContent += `\n\n${planSummaryText}`;
                send({ type: 'content', content: `\n\n${planSummaryText}` });

                console.log(`   📋 Plan complete: ${planResult.succeeded} succeeded, ${planResult.failed} failed`);
              } else {
                console.log(`   📋 LLM determined no plan needed — falling through to simple loop`);
              }
            } catch (planError) {
              console.warn(`   ⚠️  Planner error, falling back to simple loop:`, planError instanceof Error ? planError.message : planError);
            }
          }

          // ================================================================
          // AGENTIC LOOP — iterate until LLM stops calling tools or limit
          // ================================================================
          let iteration = 0;
          let forceToolCall = false; // Set to true after nudge to force tool_choice:'required'
          let nudgeCount = 0; // Track how many times we've nudged (max 5)
          const executedToolCache = new Map<string, unknown>(); // Dedup: normalizedKey → result
          const failedCallCache = new Map<string, string>(); // Cache: dedupKey → error message
          const toolCallCounts = new Map<string, number>(); // Per-tool name call counter
          const brokenTools = new Set<string>(); // Tool names blocked due to config/auth errors
          const toolFailureCounts = new Map<string, number>(); // Per-tool name failure counter
          let consecutiveFailures = 0; // Abort after MAX_CONSECUTIVE_FAILURES
          const MAX_CONSECUTIVE_FAILURES = 3;
          const MAX_CALLS_PER_TOOL = 5; // Max times any single tool can be called per request
          const MAX_FAILURES_PER_TOOL = 2; // Block tool after this many failures (any error)
          const choomTag = `[${choom.name}]`;
          console.log(`   🛠️  ${choomTag} Tools available: ${activeTools.length} (${activeTools.map(t => t.name).join(', ')})${skillDispatch ? ' [skill dispatch]' : ''}`);

          // If plan fully succeeded, reduce remaining iterations (just summary/follow-up).
          // If plan partially failed, keep full iterations so the model can finish remaining work.
          // Never override a per-project maxIterations setting.
          if (planFullySucceeded && !projectIterationLimitApplied) {
            maxIterations = Math.min(maxIterations, 3);
          }

          // Preserve any pre-loop content (e.g., plan summaries) so the final iteration can prefix it
          const preLoopContent = fullContent;

          while (iteration < maxIterations) {
            iteration++;

            if (iteration > 1) {
              send({ type: 'agent_iteration', iteration, maxIterations });
              console.log(`   🔄 ${choomTag} Agent iteration ${iteration}/${maxIterations}`);
            }

            // Stream LLM response
            let iterationContent = '';
            let toolCallsAccumulator = new Map<
              number,
              { id: string; name: string; arguments: string }
            >();
            let finishReason = 'stop';

            // Create timeout for this iteration
            const timeoutMs = 120000;
            const timeoutPromise = new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error('LLM response timeout')), timeoutMs);
            });

            const toolChoiceOverride = forceToolCall ? 'required' as const : undefined;
            if (forceToolCall) {
              console.log(`   ⚡ Using tool_choice='required' to force tool invocation`);
              forceToolCall = false; // Reset after use
            }

            const streamPromise = (async () => {
              for await (const chunk of llmClient.streamChat(currentMessages, activeTools, undefined, toolChoiceOverride)) {
                const choice = chunk.choices[0];
                if (!choice) continue;

                if (choice.delta.content) {
                  iterationContent += choice.delta.content;
                  send({ type: 'content', content: choice.delta.content });
                }

                if (choice.delta.tool_calls) {
                  accumulateToolCalls(toolCallsAccumulator, choice.delta);
                }

                if (choice.finish_reason) {
                  finishReason = choice.finish_reason;
                }
              }
            })();

            try {
              await Promise.race([streamPromise, timeoutPromise]);
            } catch (timeoutError) {
              const errMsg = timeoutError instanceof Error ? timeoutError.message : String(timeoutError);
              console.warn(`   ⚠️  LLM response error on iteration ${iteration}: ${errMsg}`);
              if (!iterationContent && iteration === 1) {
                iterationContent = "I'm sorry, the response timed out. Please try again.";
                send({ type: 'content', content: iterationContent });
              }
              break;
            }

            // Convert accumulated tool calls (with malformed JSON protection)
            let toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[] = [];
            if (toolCallsAccumulator.size > 0) {
              try {
                toolCalls = Array.from(toolCallsAccumulator.values()).map(
                  (tc) => ({
                    id: tc.id,
                    name: tc.name,
                    arguments: JSON.parse(tc.arguments || '{}'),
                  })
                );
              } catch (parseErr) {
                // Model returned malformed tool call JSON — treat as no tool calls
                console.warn(`   ⚠️  Malformed tool call arguments — treating as text-only response:`, parseErr);
                toolCalls = [];
              }
            }

            // If no valid tool calls, check if the LLM described actions instead of calling tools
            if (toolCalls.length === 0) {
              const lowerContent = iterationContent.toLowerCase();
              // Only nudge if no tools have been attempted yet this request — if tools
              // already ran (success or failure), the LLM has done real work.
              const hasExecutedTools = executedToolCache.size > 0;
              const hasAttemptedTools = hasExecutedTools || failedCallCache.size > 0;

              // Two-tier nudge detection:
              // Tier 1 (STRONG): LLM describes specific tool actions it should be performing
              //   e.g. "I created 3 images", "Here are the selfies", "generating a portrait"
              //   These ALWAYS nudge regardless of response length.
              // Tier 2 (WEAK): Generic action-suggesting preambles like "let me check..."
              //   These only nudge for SHORT responses (<500 chars) to avoid false positives
              //   on long conversational responses that happen to contain "let me share".
              const describesToolAction = !hasAttemptedTools &&
                /(?:(?:generat|creat|mak|produc|design|render|draw|craft|captur|snap)\w*\s+(?:\d+\s+)?(?:unique\s+|some\s+|a\s+|an\s+|the\s+|your\s+|my\s+)?(?:image|selfie|portrait|picture|photo|illustration|artwork))|(?:(?:search|check|fetch|get|grab|download|send|analyz|look\w* up)\w*\s+(?:the |your |a |for )?(?:weather|forecast|web|image|file|email|contact|video|result|drone|review))|(?:(?:here(?:'s| is| are)|i (?:created|generated|made|took|prepared|composed|rendered))\s+(?:the |your |some |a |\d+ )?(?:\w+ )?(?:image|selfie|portrait|picture|photo|illustration|result|file|forecast))|(?:i (?:created|generated|made)\s+\d+\s+\w+)/i.test(lowerContent);

              const isShortPreamble = iterationContent.length < 500;
              const suggestsAction = isShortPreamble &&
                /\b(let me(?! know| share| tell| explain| describe| show you what| be )|i'll (?!be\b)|i will (?!be\b)|i can (?!help|assist)|i'?m going to|here(?:'s| is) (?:a |your |the )|checking|looking up|searching|analyzing|fetching|downloading|setting up|working on)\b/.test(lowerContent);

              const suggestsToolUse = describesToolAction || suggestsAction;
              if (nudgeCount < 3 && suggestsToolUse && !hasAttemptedTools) {
                nudgeCount++;
                console.log(`   🔄 LLM described actions without calling tools — nudge ${nudgeCount}/3 (${describesToolAction ? 'tool-action match' : 'preamble match'}) with tool_choice=required`);
                currentMessages.push({ role: 'assistant', content: iterationContent });
                currentMessages.push({
                  role: 'user',
                  content: `[System] You described what you would do but did not call any tools. You MUST use function calls — do NOT describe what you plan to do or narrate the action. Call the tool NOW using the function calling format. For images/selfies use generate_image, for weather use get_weather, for files use workspace_write_file, for search use web_search. Do not reply with text — only make a tool call.`,
                });
                forceToolCall = true;
                continue;
              }
              // Final iteration (no tools, no nudge) — use only this iteration's content
              // as the saved response. Previous iterations' text was preamble (already streamed
              // but shouldn't be saved to DB since the LLM tends to repeat it).
              // Preserve any pre-loop content (e.g., plan summaries).
              fullContent = preLoopContent
                ? preLoopContent + '\n\n' + iterationContent
                : iterationContent;
              break;
            }

            // Iteration has tool calls — the text is just preamble ("Let me check...").
            // It was already streamed to the user but we don't accumulate it into fullContent
            // because the LLM will produce the real response after getting tool results.
            // Only keep it if this is the first iteration and no prior content exists,
            // as a fallback in case the loop exits unexpectedly.
            if (!fullContent && iterationContent) {
              fullContent = iterationContent;
            }

            // Track all tool calls for DB save
            allToolCalls = [...allToolCalls, ...toolCalls];

            // Execute tool calls — parallel for read-only tools, sequential for mutating tools
            const PARALLEL_SAFE = new Set([
              'get_weather', 'get_weather_forecast', 'web_search',
              'search_memories', 'search_by_type', 'search_by_tags', 'get_recent_memories',
              'search_by_date_range', 'get_memory_stats',
              'workspace_read_file', 'workspace_list_files',
              'analyze_image', 'scrape_page_images',
              'ha_get_state', 'ha_list_entities', 'ha_get_history', 'ha_get_home_status',
              'list_team', 'get_delegation_result',
              'list_emails', 'read_email', 'search_emails',
              'search_contacts', 'get_contact',
              'search_youtube', 'get_video_details', 'get_channel_info', 'get_playlist_items',
            ]);

            const iterationResults: ToolResult[] = [];

            // Pre-flight check: returns a ToolResult if the call should be skipped, or null to proceed
            const preFlightCheck = (tc: { id: string; name: string; arguments: Record<string, unknown> }): ToolResult | null => {
              const normalizedArgs = JSON.stringify(tc.arguments).toLowerCase();
              const dedupKey = `${tc.name}:${normalizedArgs}`;

              // --- Deduplication: skip if same tool+args already executed ---
              const cachedResult = executedToolCache.get(dedupKey);
              if (cachedResult !== undefined) {
                console.log(`   🔁 Skipping duplicate tool call: ${tc.name}`);
                const cachedObj = (typeof cachedResult === 'object' && cachedResult !== null && !Array.isArray(cachedResult))
                  ? { ...cachedResult as Record<string, unknown>, _note: 'This tool was already called with the same arguments. Use the previous result.' }
                  : { _cachedResult: cachedResult, _note: 'This tool was already called with the same arguments. Use the previous result.' };
                return { toolCallId: tc.id, name: tc.name, result: cachedObj };
              }

              // --- Image generation cap ---
              if (tc.name === 'generate_image' && imageGenCount >= 3) {
                console.log(`   🖼️  Skipping generate_image (${imageGenCount}/3 already generated this request)`);
                return { toolCallId: tc.id, name: tc.name, result: { success: false, message: `Image generation limit reached (${imageGenCount}/3 this turn). Cannot generate more images in this request.` } };
              }

              // --- Per-tool call counter ---
              const currentToolCount = (toolCallCounts.get(tc.name) || 0) + 1;
              toolCallCounts.set(tc.name, currentToolCount);
              if (tc.name !== 'generate_image' && currentToolCount > MAX_CALLS_PER_TOOL) {
                console.log(`   🛑 Tool call limit reached for ${tc.name} (${currentToolCount}/${MAX_CALLS_PER_TOOL})`);
                return { toolCallId: tc.id, name: tc.name, result: { success: false, message: `Tool ${tc.name} has been called ${currentToolCount} times this request (limit: ${MAX_CALLS_PER_TOOL}). You must try a different approach or present your results to the user.` } };
              }

              // --- Broken tool blocking (config error or repeated failures) ---
              if (brokenTools.has(tc.name)) {
                console.log(`   🚫 ${tc.name} blocked (broken tool — will not retry)`);
                return { toolCallId: tc.id, name: tc.name, result: null, error: `${tc.name} has been disabled for this request because it failed repeatedly. Do NOT call ${tc.name} again. Tell the user what went wrong and suggest alternatives.` };
              }

              // --- Failed call cache ---
              const cachedError = failedCallCache.get(dedupKey);
              if (cachedError) {
                console.log(`   🔁 Returning cached failure for ${tc.name} (same args already failed)`);
                return { toolCallId: tc.id, name: tc.name, result: null, error: `${cachedError} [This exact call already failed. Try a different approach or different arguments.]` };
              }

              return null; // Proceed with execution
            };

            // Execute a single tool call and handle post-execution bookkeeping
            const executeAndProcess = async (tc: { id: string; name: string; arguments: Record<string, unknown> }): Promise<ToolResult> => {
              send({ type: 'tool_call', toolCall: tc });
              serverLog(choomId, chatId, 'info', 'system', `Tool Call: ${tc.name}`,
                `Arguments: ${JSON.stringify(tc.arguments).slice(0, 200)}`,
                { toolName: tc.name, arguments: tc.arguments });

              const normalizedArgs = JSON.stringify(tc.arguments).toLowerCase();
              const dedupKey = `${tc.name}:${normalizedArgs}`;

              let result: ToolResult;
              try {
                result = skillDispatch
                  ? await executeToolCallViaSkills(tc, ctx)
                  : await executeToolCall(tc, ctx);
              } catch (toolErr) {
                const toolErrMsg = toolErr instanceof Error ? toolErr.message : String(toolErr);
                console.error(`   ❌ Tool execution error for ${tc.name}:`, toolErrMsg);
                result = { toolCallId: tc.id, name: tc.name, result: null, error: `Tool execution failed: ${toolErrMsg}` };
              }

              // Cache results
              if (!result.error) {
                executedToolCache.set(dedupKey, result.result);
                consecutiveFailures = 0;
              } else {
                failedCallCache.set(dedupKey, result.error);
                // Classify the error to decide blocking and counting strategy:
                // - Config/auth errors → block immediately (model can't fix these)
                // - Missing param errors → DON'T count toward any failure cap (model can fix by providing params)
                // - Other errors → count toward per-tool cap and consecutive failures
                const isConfigError = /not configured|api key|unauthorized|forbidden|invalid.*(?:model|endpoint|key)|ECONNREFUSED/i.test(result.error);
                const isParamError = /missing required parameter|is required|must provide|please provide/i.test(result.error);
                if (isParamError) {
                  // Param errors are recoverable — don't count toward any failure cap
                  // The LLM can fix by providing the correct params on the next call
                  console.log(`   ⚠️  ${tc.name}: param error (recoverable, not counted as failure)`);
                } else if (isConfigError && !brokenTools.has(tc.name)) {
                  consecutiveFailures++;
                  brokenTools.add(tc.name);
                  console.log(`   🚫 ${tc.name} blocked for rest of request (config error)`);
                } else {
                  consecutiveFailures++;
                  // Count other failures toward per-tool cap
                  const toolFails = (toolFailureCounts.get(tc.name) || 0) + 1;
                  toolFailureCounts.set(tc.name, toolFails);
                  if (toolFails >= MAX_FAILURES_PER_TOOL && !brokenTools.has(tc.name)) {
                    brokenTools.add(tc.name);
                    console.log(`   🚫 ${tc.name} blocked after ${toolFails} non-param failures this request`);
                  }
                }
                if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                  console.log(`   🛑 ${MAX_CONSECUTIVE_FAILURES} consecutive tool failures — aborting loop`);
                }
              }

              // Check for soft failure (success:false in result body)
              if (!result.error && result.result && typeof result.result === 'object' && (result.result as Record<string, unknown>).success === false) {
                consecutiveFailures++;
                if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                  console.log(`   🛑 ${MAX_CONSECUTIVE_FAILURES} consecutive tool failures (soft) — aborting loop`);
                }
              }

              // Track successful image generation
              if (tc.name === 'generate_image' && !result.error) {
                imageGenCount++;
              }

              send({ type: 'tool_result', toolResult: result });

              // Log details (strip large base64)
              const resultDetails: Record<string, unknown> = { toolName: result.name };
              if (result.error) {
                resultDetails.error = result.error;
              } else if (result.result && typeof result.result === 'object') {
                const cleaned = { ...(result.result as Record<string, unknown>) };
                if ('imageUrl' in cleaned) delete cleaned.imageUrl;
                if ('image_base64' in cleaned) delete cleaned.image_base64;
                resultDetails.result = cleaned;
              } else {
                resultDetails.result = result.result;
              }
              serverLog(choomId, chatId, result.error ? 'error' : 'success', 'system',
                `Tool Result: ${result.name}`, result.error || 'Success', resultDetails);

              // Project metadata tracking
              const wsPath = (tc.arguments.path as string) || (tc.arguments.image_path as string) || '';
              const topFolder = decodeURIComponent(wsPath.split('/')[0]);

              if (!projectIterationLimitApplied && topFolder) {
                try {
                  const projectService = new ProjectService(WORKSPACE_ROOT);
                  const project = await projectService.getProject(topFolder);
                  if (project?.metadata.maxIterations && project.metadata.maxIterations > 0) {
                    maxIterations = project.metadata.maxIterations;
                    projectIterationLimitApplied = true;
                    console.log(`   📂 Project "${topFolder}": maxIterations overridden to ${maxIterations}`);
                  }
                } catch { /* ignore project read errors */ }
              }

              const projectUpdateTools = ['workspace_write_file', 'workspace_create_folder', 'workspace_read_file', 'workspace_list_files', 'analyze_image', 'download_web_image', 'download_web_file', 'workspace_read_pdf', 'execute_code', 'create_venv', 'install_package', 'run_command', 'workspace_rename_project', 'save_generated_image'];
              if (projectUpdateTools.includes(tc.name) && topFolder && !result.error) {
                try {
                  const projectService = new ProjectService(WORKSPACE_ROOT);
                  await projectService.updateProjectMetadata(topFolder, {
                    lastModified: new Date().toISOString(),
                    assignedChoom: choom.name,
                  });
                } catch { /* ignore metadata update errors */ }
              }

              return result;
            };

            // Phase 1: Run pre-flight checks on all tool calls
            const preFlightResults = new Map<string, ToolResult>(); // tc.id → result
            const pendingCalls: typeof toolCalls = [];
            for (const tc of toolCalls) {
              const skipped = preFlightCheck(tc);
              if (skipped) {
                preFlightResults.set(tc.id, skipped);
                allToolResults.push(skipped);
                if (skipped.error) consecutiveFailures++;
                send({ type: 'tool_call', toolCall: tc });
                send({ type: 'tool_result', toolResult: skipped });
              } else {
                pendingCalls.push(tc);
              }
            }

            // Phase 2: Partition pending calls into parallel-safe and sequential
            const parallelCalls = pendingCalls.filter(tc => PARALLEL_SAFE.has(tc.name));
            const sequentialCalls = pendingCalls.filter(tc => !PARALLEL_SAFE.has(tc.name));

            // Execute parallel-safe tools concurrently
            const parallelResults = new Map<string, ToolResult>();
            if (parallelCalls.length > 1) {
              console.log(`   ⚡ Executing ${parallelCalls.length} read-only tools in parallel: ${parallelCalls.map(tc => tc.name).join(', ')}`);
              const results = await Promise.all(parallelCalls.map(tc => executeAndProcess(tc)));
              for (let i = 0; i < parallelCalls.length; i++) {
                parallelResults.set(parallelCalls[i].id, results[i]);
                allToolResults.push(results[i]);
              }
            } else if (parallelCalls.length === 1) {
              // Single parallel-safe call — no benefit from Promise.all, just execute
              const result = await executeAndProcess(parallelCalls[0]);
              parallelResults.set(parallelCalls[0].id, result);
              allToolResults.push(result);
            }

            // Execute sequential (mutating) tools one at a time
            const sequentialResults = new Map<string, ToolResult>();
            for (const tc of sequentialCalls) {
              const result = await executeAndProcess(tc);
              sequentialResults.set(tc.id, result);
              allToolResults.push(result);
            }

            // Merge results in original tool call order
            for (const tc of toolCalls) {
              const r = preFlightResults.get(tc.id) || parallelResults.get(tc.id) || sequentialResults.get(tc.id);
              if (r) iterationResults.push(r);
            }

            // If ALL tools in this iteration failed and we've seen 2+ total failures,
            // inject an abort hint so the LLM doesn't loop endlessly.
            const allFailedThisIteration = iterationResults.length > 0 &&
              iterationResults.every(r => r.error || (r.result && typeof r.result === 'object' && (r.result as Record<string, unknown>).success === false));
            if (allFailedThisIteration && failedCallCache.size >= 2) {
              currentMessages.push({
                role: 'user',
                content: '[System] Multiple tool calls have failed. STOP retrying. Tell the user what went wrong and suggest they check their settings. Do NOT call any more tools.',
              });
              console.log(`   🛑 All tools failed this iteration (${failedCallCache.size} total failures) — injected abort hint`);
            }

            // Build messages for next iteration: append assistant message + tool results
            // IMPORTANT: Strip imageUrl from results before sending to LLM
            currentMessages.push({
              role: 'assistant',
              content: iterationContent || '',
              tool_calls: toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function' as const,
                function: {
                  name: tc.name,
                  arguments: JSON.stringify(tc.arguments),
                },
              })),
            });

            for (const tr of iterationResults) {
              let resultForLLM = tr.result;
              if (tr.name === 'generate_image' && tr.result && typeof tr.result === 'object') {
                const { imageUrl, ...rest } = tr.result as Record<string, unknown>;
                resultForLLM = rest;
                if (imageUrl) {
                  const sizeMB = ((imageUrl as string).length / 1024 / 1024).toFixed(1);
                  console.log(`   🖼️  Image generated (${sizeMB}MB base64 stripped from LLM context)`);
                }
              }
              currentMessages.push({
                role: 'tool' as const,
                content: JSON.stringify(resultForLLM),
                tool_call_id: tr.toolCallId,
                name: tr.name,
              });
            }

            // --- Consecutive failure abort: tell LLM to stop and present results ---
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
              currentMessages.push({
                role: 'user',
                content: `[System] Multiple consecutive tool calls have failed. STOP retrying. Do NOT call any more tools. Instead, summarize what you were able to accomplish and explain to the user what went wrong. If you couldn't complete the task, suggest an alternative approach the user could try.`,
              });
              console.log(`   🛑 Injected abort message after ${consecutiveFailures} consecutive failures — 1 final iteration to summarize`);
              // Allow one more iteration for the LLM to produce a summary, then force-exit
              // We don't break here — the loop will continue, but with no tools the LLM should
              // produce text only, which will hit the break at the toolCalls.length===0 check
            }

            const approxTokens = Math.ceil(currentMessages.map(m => m.content).join('').length / 4);
            console.log(`   🔧 ${choomTag} Next iteration | ${currentMessages.length} msgs | ~${approxTokens.toLocaleString()} tokens`);

            // Within-turn compaction: truncate old tool results if context is getting large
            const withinTurnResult = compactionService.compactWithinTurn(currentMessages, systemPromptWithSummary, activeTools, 2);
            if (withinTurnResult.truncatedCount > 0) {
              // Replace currentMessages contents in-place
              currentMessages.length = 0;
              currentMessages.push(...withinTurnResult.messages);
              console.log(`   🗜️  Within-turn compaction: truncated ${withinTurnResult.truncatedCount} tool results, recovered ~${withinTurnResult.tokensRecovered.toLocaleString()} tokens`);
            }
          }

          // If we hit the max iterations limit, append a note
          if (iteration >= maxIterations) {
            const note = '\n\n[Reached maximum tool iterations]';
            fullContent += note;
            send({ type: 'content', content: note });
            console.log(`   ⚠️  Hit maxIterations (${maxIterations}${projectIterationLimitApplied ? ' — per-project override' : ''})`);
          }

          // Post-process: strip absolute file paths from response
          const cleanedContent = fullContent.replace(
            /\/home\/[^\s"')}\]]+/g,
            (match) => {
              // Extract just the filename
              const parts = match.split('/');
              return parts[parts.length - 1];
            }
          ).replace(
            /\/tmp\/[^\s"')}\]]+/g,
            (match) => {
              const parts = match.split('/');
              return parts[parts.length - 1];
            }
          );

          // Save assistant message with all tool calls/results
          await prisma.message.create({
            data: {
              chatId,
              role: 'assistant',
              content: cleanedContent,
              toolCalls: allToolCalls.length > 0 ? JSON.stringify(allToolCalls) : null,
              toolResults: allToolResults.length > 0 ? JSON.stringify(allToolResults) : null,
            },
          });

          // Update chat timestamp
          await prisma.chat.update({
            where: { id: chatId },
            data: { updatedAt: new Date() },
          });

          const elapsed = Date.now() - requestStartTime;
          serverLog(choomId, chatId, 'success', 'llm', 'LLM Response',
            `${llmSettings.model} (${fullContent.length} chars, ${iteration} iteration${iteration > 1 ? 's' : ''})`,
            { model: llmSettings.model, charCount: fullContent.length, iterations: iteration, fullResponse: fullContent.slice(0, 2000),
              toolCallCount: allToolCalls.length, toolNames: allToolCalls.map(t => t.name) },
            elapsed);
          send({ type: 'done', content: fullContent, resolvedModel: llmSettings.model });
        } catch (error) {
          console.error('   ❌ Chat error:', error instanceof Error ? error.message : error);
          send({
            type: 'error',
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        } finally {
          // Clear GUI activity marker so heartbeats can resume
          if (!isDelegation) {
            clearGuiActivity(choom.name);
          }
          if (!streamClosed) {
            try { controller.close(); } catch { /* already closed */ }
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    console.error('❌ Chat API error:', error instanceof Error ? error.message : error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
