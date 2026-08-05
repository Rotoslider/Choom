/**
 * Tool execution for the chat route — carved out of app/api/chat/route.ts
 * (C-22; the code is a verbatim move, only imports/exports were added).
 *
 * Owns: the ToolContext contract, the legacy executeToolCall dispatcher
 * (~40 tools), the skill-dispatch wrapper executeToolCallViaSkills with its
 * contractGate policy checks, and the two system-prompt tool-doc builders.
 * The agentic loop in route.ts calls these once per tool call; nothing here
 * knows about streaming or the loop itself.
 */
import prisma from '@/lib/db';
import { MemoryClient, executeMemoryTool } from '@/lib/memory-client';
import { ImageGenClient, buildPromptWithLoras } from '@/lib/image-gen-client';
import { WeatherService } from '@/lib/weather-service';
import { WebSearchService } from '@/lib/web-search';
import { WorkspaceService } from '@/lib/workspace-service';
import { requireStringArg } from '@/lib/tool-arg-guard';
import { VisionService } from '@/lib/vision-service';
import { ProjectService } from '@/lib/project-service';
import type {
  VisionSettings, LLMProviderConfig, VisionModelProfile,
  ToolCall, ToolResult, ImageGenSettings, WeatherSettings, SearchSettings, ImageSize, ImageAspect,
} from '@/lib/types';
import { computeImageDimensions } from '@/lib/types';
import { findVisionProfile } from '@/lib/model-profiles';
import { memoryTools } from '@/lib/tool-definitions';
import { getSkillRegistry } from '@/lib/skill-registry';
import { suggestToolNames } from '@/lib/tool-name-suggest';
import type { SkillHandlerContext } from '@/lib/skill-handler';
import { getGoogleClient } from '@/lib/google-client';
import { waitForGpu } from '@/lib/gpu-lock';
import * as fs from 'fs';
import * as path from 'path';
import {
  WORKSPACE_ROOT, WORKSPACE_MAX_FILE_SIZE_KB,
  WORKSPACE_ALLOWED_EXTENSIONS, WORKSPACE_IMAGE_EXTENSIONS, WORKSPACE_DOWNLOAD_EXTENSIONS,
} from '@/lib/config';
import {
  defaultLLMSettings, defaultSearchSettings, defaultImageGenSettings, DEFAULT_IMAGE_GEN_ENDPOINT,
} from '@/lib/chat-defaults';

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

// ============================================================================
// Tool execution context
// ============================================================================

export interface ToolContext {
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
  suppressNotifications?: boolean;
  isHeartbeat?: boolean;
  activeProjectFolder?: string;
  isDelegation?: boolean;
  // Slug of the Choom that delegated this task (e.g. "optic"). When set, the
  // worker is allowed to write into the delegator's own selfies_ folder, since
  // the artifacts it produces belong to the delegator's task.
  delegatorSlug?: string;
  // Room this turn is happening in (group turns only) — lets schedule_room_followup
  // know which room to return to.
  groupRoomId?: string;
}

// ============================================================================
// Extracted tool execution function
// ============================================================================

export async function executeToolCall(
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
      memoryCompanionId,
      { isHeartbeat: ctx.isHeartbeat }
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
    // Wait for GPU if it's occupied by a long-running command (training, inference)
    const gpuWait = await waitForGpu(180_000, 10_000);
    if (!gpuWait.free) {
      console.log(`   🚫 Image generation skipped — GPU still busy after ${Math.round(gpuWait.waitedMs / 1000)}s: ${gpuWait.reason}`);
      return { toolCallId: toolCall.id, name: toolCall.name, result: { success: false }, error: `GPU is busy with: ${gpuWait.reason}. Waited ${Math.round(gpuWait.waitedMs / 1000)}s but it didn't free up. Try again later.` };
    }

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
        // Reclaim disk space from deleted image blobs
        await prisma.$queryRawUnsafe('PRAGMA incremental_vacuum');
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

      // Detect general-knowledge date queries (holidays, seasons, astronomical events)
      // that the model mistakenly sent to the calendar tool. Return as an error so the
      // model answers from its own knowledge instead of relaying "no events found".
      // Only triggers for date/holiday patterns — personal queries like "dentist" or
      // "meeting with Bob" correctly return "no events found" as a normal result.
      if (events.length === 0 && query) {
        // Multi-word phrases are always general knowledge. Bare holiday names
        // only match when they're the entire query (not "christmas party").
        const isPhraseGK = /(?:first|last) day of (?:spring|summer|autumn|fall|winter)|(?:start|end|beginning) of (?:spring|summer|autumn|fall|winter)|(?:spring|vernal|autumnal|fall) equinox|(?:summer|winter) solstice/i.test(query);
        const termStripped = query.replace(/\b\d{4}\b/g, '').trim();
        const isBareHoliday = /^(?:easter|christmas|hanukkah|kwanzaa|ramadan|diwali|thanksgiving|new year|independence day|memorial day|labor day|martin luther king|presidents day|veterans day)$/i.test(termStripped);
        if (isPhraseGK || isBareHoliday) {
          console.log(`   📅 Calendar: 0 events for general knowledge query "${query}" — returning as error`);
          return {
            toolCallId: toolCall.id,
            name: toolCall.name,
            result: null,
            error: `No personal calendar events match "${query}". This tool only searches your Google Calendar for personal events. Answer the user's question from your own knowledge — do NOT say "no events found".`,
          };
        }
      }

      const formatted = events.length === 0
        ? (daysBack ? 'No events found in that time range.' : 'No upcoming events found.')
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

      // C-50: shared with the google-drive skill handler, which implements
      // this tool a second time. 11/11 calls failed because the model sends
      // `path` while both copies read `workspace_path`, and Node's path.join
      // error taught the wrong name back to it.
      requireStringArg('upload_to_drive', toolCall.arguments, 'workspace_path',
        { example: 'choom_commons/report.pdf' });

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
      let timeStr = toolCall.arguments.time as string | undefined;

      // Clean up text: strip stray time abbreviations like "1.m.", "a.m.", "p.m."
      text = text.replace(/\b\d+\.m\.\s*/gi, '').replace(/\b[ap]\.m\.\s*/gi, '').trim();

      // AM/PM cross-check: if the user's message explicitly says "pm" but the LLM
      // sent "AM" (or vice versa), correct it. LLMs frequently confuse AM/PM.
      if (timeStr && message) {
        const userMsgLower = message.toLowerCase();
        const userSaidPM = /\b\d{1,2}\s*(?:p\.?m\.?|pm)\b/i.test(userMsgLower);
        const userSaidAM = /\b\d{1,2}\s*(?:a\.?m\.?|am)\b/i.test(userMsgLower);
        const llmSaidAM = /AM$/i.test(timeStr.trim());
        const llmSaidPM = /PM$/i.test(timeStr.trim());
        if (userSaidPM && llmSaidAM && !userSaidAM) {
          console.log(`   ⚠️  AM/PM mismatch: user said PM, LLM sent "${timeStr}" — correcting to PM`);
          timeStr = timeStr.replace(/AM$/i, 'PM');
        } else if (userSaidAM && llmSaidPM && !userSaidPM) {
          console.log(`   ⚠️  AM/PM mismatch: user said AM, LLM sent "${timeStr}" — correcting to AM`);
          timeStr = timeStr.replace(/PM$/i, 'AM');
        }
      }

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
      let content = await ws.readFile(filePath);
      // Truncate large reads to prevent context bloat / LLM timeouts
      const ext = filePath.split('.').pop()?.toLowerCase() || '';
      const dataExts = new Set(['json', 'csv', 'tsv', 'xml', 'log']);
      const maxChars = dataExts.has(ext) ? 12000 : 30000;
      if (content.length > maxChars) {
        const originalLen = content.length;
        content = content.slice(0, maxChars) + `\n\n[... truncated — showing first ${maxChars.toLocaleString()} of ${originalLen.toLocaleString()} chars]`;
      }
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
  if (toolCall.name === 'send_notification' && ctx.suppressNotifications) {
    console.log(`   🔇 send_notification suppressed (suppressNotifications=true)`);
    return {
      toolCallId: toolCall.id,
      name: toolCall.name,
      result: { success: true, message: 'Notification suppressed — response will be delivered directly.' },
    };
  }
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
        if (visionProvider) {
          if (visionProvider.apiKey) {
            visionApiKey = visionProvider.apiKey;
          }
          if (visionProvider.endpoint) {
            // Use provider endpoint — strip /v1 suffix since VisionService adds it
            visionEndpoint = visionProvider.endpoint.replace(/\/v1\/?$/, '');
          }
        } else {
          console.warn(`   ⚠️  Vision provider "${visionProviderId}" not found in ${visionProviders.length} providers (available: ${visionProviders.map(p => p.id).join(', ')}). Falling back to endpoint: ${visionEndpoint}`);
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
      console.log(`   👁️  Vision config: model=${visionModel}, endpoint=${visionEndpoint}, provider=${visionProviderId || 'none'}, hasApiKey=${!!visionApiKey}`);

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
      const rawVisionErr = err instanceof Error ? err.message : 'Unknown error';
      // C-50: this copy of analyze_image dead-ended on a bad filename while
      // the skill-handler copy listed the directory — same missing file, same
      // day, two different errors. Share the formatter so they cannot drift.
      if (/ENOENT|no such file/i.test(rawVisionErr)) {
        const wanted = (toolCall.arguments?.image_path as string) || '';
        const { formatImageNotFoundError } = await import('@/lib/dir-suggest');
        const friendly = await formatImageNotFoundError(wanted);
        if (friendly) {
          console.log(`   🖼️  ${wanted} not found — auto-listed nearest directory`);
          return { toolCallId: toolCall.id, name: toolCall.name, result: null, error: friendly };
        }
      }
      console.error('   ❌ Vision error:', rawVisionErr);
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Vision analysis failed: ${rawVisionErr}`,
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

export function getHardcodedToolDocs(): string {
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

/**
 * Contract gate — narrow enforcement of SAFETY_CONTRACT.md. Runs just before
 * the handler executes. Returns null to let the call through, or a ToolResult
 * to short-circuit with an error or benign no-op.
 *
 * Most contract items are enforced elsewhere (MAX_CALLS_PER_TOOL, delegation
 * tool stripping, send_notification suppression, image cap, schedule_self_followup
 * internal cap). This gate only handles the genuinely new cases:
 *   - workspace_write_file: audit-log writes into shared top-level paths
 *   - workspace_delete_file: block deletes outside the Choom's own folder
 *     and block all deletes inside sibling_journal/
 */
function contractGate(toolCall: ToolCall, ctx: ToolContext): ToolResult | null {
  const choomName = (ctx.choom as Record<string, unknown>)?.name as string || '';
  const choomSlug = choomName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const ownFolderPrefix = choomSlug ? `selfies_${choomSlug}/` : '';

  const SHARED_TOP = new Set(['choom_commons']);

  if (toolCall.name === 'workspace_write_file') {
    const rawPath = (toolCall.arguments.path || toolCall.arguments.file_path || toolCall.arguments.filename) as string || '';
    const firstSeg = rawPath.split('/').filter(Boolean)[0] || '';
    const isShared = SHARED_TOP.has(firstSeg);
    const isOwn = ownFolderPrefix && rawPath.startsWith(ownFolderPrefix);
    if (firstSeg === 'sibling_journal') {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        error: `Blocked: sibling_journal/ is archived (read-only). Write all cross-Choom content to choom_commons/for_[their_name]/ instead.`,
        result: null,
      };
    } else if (isShared) {
      console.log(`   📒 [contract] ${choomName} writing to shared ${firstSeg}/: ${rawPath}`);
    } else if (ownFolderPrefix && !isOwn && firstSeg.startsWith('selfies_') && firstSeg !== `selfies_${choomSlug}`) {
      // Cross-Choom write into another Choom's selfies folder.
      const delegatorPrefix = ctx.delegatorSlug ? `selfies_${ctx.delegatorSlug}/` : '';
      if (ctx.isDelegation && delegatorPrefix && rawPath.startsWith(delegatorPrefix)) {
        // The worker is executing the delegator's task, so artifacts belong in
        // the delegator's folder — allow it. (Falls through to `return null`.)
        console.log(`   📒 [contract] ${choomName} (delegated by ${ctx.delegatorSlug}) writing to delegator folder: ${rawPath}`);
      } else if (ctx.isDelegation) {
        // Cross-Choom write to a NON-delegator folder during a delegated task.
        // Don't hard-block — a block here counts toward the per-tool failure cap
        // and disables workspace_write_file for the whole request (so even the
        // worker's own-folder writes start failing). Redirect into the shared
        // commons inbox for that Choom so the artifact still lands somewhere sane.
        const targetSlug = firstSeg.replace(/^selfies_/, '');
        const rest = rawPath.split('/').filter(Boolean).slice(1).join('/') || 'note.md';
        const redirected = `choom_commons/for_${targetSlug}/${rest}`;
        console.warn(`   🔀 [contract] Delegated cross-Choom write redirected: "${rawPath}" → "${redirected}"`);
        toolCall.arguments.path = redirected;
        delete toolCall.arguments.file_path;
        delete toolCall.arguments.filename;
      } else {
        // Not a delegation — accidental cross-pollination. Keep blocking.
        return {
          toolCallId: toolCall.id,
          name: toolCall.name,
          error: `Blocked: cannot write into another Choom's folder (${firstSeg}/). Your folder is ${ownFolderPrefix}. For messages/artifacts intended for another Choom, write to choom_commons/for_[their_name]/ (e.g. choom_commons/for_eve/your_note.md).`,
          result: null,
        };
      }
    }
  }

  if (toolCall.name === 'workspace_delete_file') {
    const rawPath = (toolCall.arguments.path || toolCall.arguments.file_path) as string || '';
    const firstSeg = rawPath.split('/').filter(Boolean)[0] || '';
    if (SHARED_TOP.has(firstSeg)) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        error: `Blocked: ${firstSeg}/ is a shared folder — never delete from it. If an entry is wrong, write a correction instead.`,
        result: null,
      };
    }
    if (ownFolderPrefix && firstSeg.startsWith('selfies_') && !rawPath.startsWith(ownFolderPrefix)) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        error: `Blocked: cannot delete from another Choom's folder (${firstSeg}/). Your folder is ${ownFolderPrefix}.`,
        result: null,
      };
    }
  }

  return null;
}

export async function executeToolCallViaSkills(
  toolCall: ToolCall,
  ctx: ToolContext
): Promise<ToolResult> {
  // Suppress send_notification when caller already delivers the response
  // (e.g. Signal bridge, scheduler). Without this, the LLM queues a
  // notification AND the caller sends the message directly → duplicate.
  if (toolCall.name === 'send_notification' && ctx.suppressNotifications) {
    console.log(`   🔇 send_notification suppressed (suppressNotifications=true)`);
    return {
      toolCallId: toolCall.id,
      name: toolCall.name,
      result: { success: true, message: 'Notification suppressed — response will be delivered directly.' },
    };
  }

  const registry = getSkillRegistry();
  let skill = registry.getSkillForTool(toolCall.name);

  if (!skill) {
    const resolved = registry.resolveToolName(toolCall.name);
    if (resolved) {
      toolCall.name = resolved;
      skill = registry.getSkillForTool(resolved)!;
    } else {
      const suggestions = suggestToolNames(
        toolCall.name,
        registry.getAllToolDefinitions().map(t => t.name),
      );
      const hint = suggestions.length
        ? ` No tool by that name exists. Did you mean: ${suggestions.join(', ')}? Call one of those instead.`
        : ' No tool by that name exists — check your tool list and call a real one.';
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Unknown tool: ${toolCall.name}.${hint}`,
      };
    }
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
      const hyphenKey = key.replace(/-/g, '_');
      if (snakeKey !== key && expectedProps.has(snakeKey) && toolCall.arguments[snakeKey] === undefined) {
        normalized[snakeKey] = value;
        changed = true;
      } else if (hyphenKey !== key && expectedProps.has(hyphenKey) && toolCall.arguments[hyphenKey] === undefined) {
        normalized[hyphenKey] = value;
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
    activeProjectFolder: ctx.activeProjectFolder,
    suppressNotifications: ctx.suppressNotifications,
    isHeartbeat: ctx.isHeartbeat,
    groupRoomId: ctx.groupRoomId,
    skillDoc: skill.fullDoc,
    getReference: (fileName: string) => registry.getLevel3Reference(skill.metadata.name, fileName),
  };

  // Narrow contract gate (see SAFETY_CONTRACT.md). Only the handful of tools
  // that touch shared state or have unusual blast radius land here — most are
  // already constrained by MAX_CALLS_PER_TOOL, the suppressNotifications flag,
  // or the delegation tool-stripping. Don't expand unless the Doctor shows a
  // failure mode that requires it.
  const gated = contractGate(toolCall, ctx);
  if (gated) {
    return gated;
  }

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
export function buildSkillToolDocs(userMessage: string): string {
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
