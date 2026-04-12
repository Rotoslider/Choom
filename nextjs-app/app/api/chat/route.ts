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
import { waitForGpu } from '@/lib/gpu-lock';
import { isMultiStepRequest, createPlan, executePlan, summarizePlan } from '@/lib/planner-loop';
import { TraceBuilder, writeTrace } from '@/lib/execution-trace';
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
  serpApiKey: process.env.SERP_API_KEY || '',
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
const WORKSPACE_ALLOWED_EXTENSIONS = [
  // Documents & data
  '.md', '.txt', '.json', '.csv', '.tsv', '.log', '.rst', '.tex', '.bib', '.diff', '.patch',
  // Web & scripting
  '.py', '.ts', '.tsx', '.js', '.jsx', '.html', '.css', '.scss', '.sass', '.less', '.graphql', '.gql',
  // Shell & system
  '.sh', '.bash', '.ps1', '.bat', '.cmd', '.conf', '.rules', '.service',
  // Config
  '.yaml', '.yml', '.xml', '.sql', '.toml', '.ini', '.cfg', '.env.example',
  // Notebooks
  '.r', '.R', '.ipynb',
  // Systems programming
  '.c', '.cpp', '.h', '.hpp', '.rs', '.go', '.java', '.kt', '.swift', '.rb', '.pl', '.lua', '.m',
  // Microcontroller & embedded
  '.ino', '.pde', '.s', '.S', '.asm', '.ld', '.dts', '.dtsi', '.kconfig', '.mk',
  // FPGA
  '.v', '.sv', '.tcl',
  // Build & infra
  '.proto', '.cmake', '.makefile', '.dockerfile', '.tf', '.hcl',
  // ROS2
  '.msg', '.srv', '.action', '.urdf', '.xacro', '.sdf', '.world', '.rviz', '.repos',
];
const WORKSPACE_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp'];
const WORKSPACE_DOWNLOAD_EXTENSIONS = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.pptx', '.zip', '.tar', '.gz', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.log', '.sh', '.bash', '.sql', '.r', '.R', '.ipynb'];

// Maximum agentic loop iterations
const MAX_ITERATIONS = 100;

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

/**
 * Check if an endpoint URL points to a local/LAN server.
 * Used to determine timeout behavior — local models need longer prefill
 * timeouts but shouldn't be penalized by cloud-oriented limits.
 * Providers with LAN endpoints (e.g., LM Studio on 192.168.x.x) are local.
 */
function isLocalEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' ||
      host.startsWith('192.168.') || host.startsWith('10.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host.endsWith('.local');
  } catch {
    return true; // assume local if URL can't be parsed
  }
}

// Attempt JSON repair for malformed tool call arguments from local models.
// Uses a state machine to properly track string context so braces/brackets
// inside strings are not miscounted (common when content contains code).
function tryRepairJSON(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  let s = raw.trim();

  // State machine: track whether we're inside a JSON string value
  // Also detect where the first root-level object ends, so we can
  // truncate concatenated objects like "{}{}" or '{"a":1}{"b":2}'
  let inString = false;
  let braceDepth = 0;
  let bracketDepth = 0;
  let firstObjectEnd = -1;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (ch === '\\') {
        i++; // skip escaped character
      } else if (ch === '"') {
        inString = false;
      }
    } else {
      if (ch === '"') inString = true;
      else if (ch === '{') braceDepth++;
      else if (ch === '}') {
        braceDepth--;
        if (braceDepth === 0 && bracketDepth === 0 && firstObjectEnd === -1) {
          firstObjectEnd = i;
        }
      }
      else if (ch === '[') bracketDepth++;
      else if (ch === ']') bracketDepth--;
    }
  }

  // If the first root object closed before the end of the string,
  // there's trailing garbage (e.g. "{}{}", '{"a":1}extra'). Truncate.
  if (firstObjectEnd !== -1 && firstObjectEnd < s.length - 1) {
    s = s.slice(0, firstObjectEnd + 1);
    try { return JSON.parse(s); } catch { /* fall through to other repairs */ }
  }

  // Close unterminated string (e.g. truncated "content": "# E)
  if (inString) {
    // Remove trailing incomplete escape sequence (lone backslash at end)
    s = s.replace(/\\$/, '');
    s += '"';
  }

  // Remove trailing commas before closing brackets/braces
  s = s.replace(/,\s*$/g, '');

  // Close open structures
  if (bracketDepth > 0) s += ']'.repeat(bracketDepth);
  if (braceDepth > 0) s += '}'.repeat(braceDepth);

  // Clean up trailing commas inside structures
  s = s.replace(/,\s*}/g, '}');
  s = s.replace(/,\s*]/g, ']');

  try { return JSON.parse(s); } catch { return null; }
}

/**
 * Create a streaming filter that strips <think>...</think> blocks emitted by
 * reasoning models (Qwen 3.x, DeepSeek-R1, etc.). Call filter() on each content
 * chunk; it returns only the visible (non-thinking) portion. Maintains state
 * across calls so tags that span chunk boundaries are handled correctly.
 */
function createThinkFilter(): (text: string) => string {
  let inThinkBlock = false;

  return function filter(text: string): string {
    if (!text) return '';
    let result = '';
    let pos = 0;

    while (pos < text.length) {
      if (inThinkBlock) {
        const closeIdx = text.indexOf('</think>', pos);
        if (closeIdx !== -1) {
          inThinkBlock = false;
          pos = closeIdx + 8; // '</think>'.length
        } else {
          break; // rest is inside think block — discard
        }
      } else {
        const openIdx = text.indexOf('<think>', pos);
        if (openIdx !== -1) {
          result += text.slice(pos, openIdx);
          inThinkBlock = true;
          pos = openIdx + 7; // '<think>'.length
        } else {
          result += text.slice(pos);
          break;
        }
      }
    }

    return result;
  };
}

/**
 * Streaming filter that strips <tool_call>...</tool_call> XML blocks from content.
 * Some local models emit tool calls as XML text instead of structured tool_calls.
 * This captures the XML for later parsing into real tool calls while hiding the
 * raw XML from the user (both web UI and Signal).
 */
function createToolCallXmlFilter(): {
  filter: (text: string) => string;
  getCaptured: () => string[];
  flush: () => string;
} {
  let inBlock = false;
  let currentBlock = '';
  let pendingBuffer = ''; // holds partial tag prefixes across chunks
  const captured: string[] = [];

  const OPEN_TAG = '<tool_call>';

  function filter(text: string): string {
    if (!text && !pendingBuffer) return '';

    // Prepend any buffered partial tag from previous chunk
    text = pendingBuffer + (text || '');
    pendingBuffer = '';

    let result = '';
    let pos = 0;

    while (pos < text.length) {
      if (inBlock) {
        const closeIdx = text.indexOf('</tool_call>', pos);
        if (closeIdx !== -1) {
          currentBlock += text.slice(pos, closeIdx);
          captured.push(currentBlock);
          currentBlock = '';
          inBlock = false;
          pos = closeIdx + 12; // '</tool_call>'.length
        } else {
          currentBlock += text.slice(pos);
          break; // rest is inside block — buffer it
        }
      } else {
        const openIdx = text.indexOf(OPEN_TAG, pos);
        if (openIdx !== -1) {
          result += text.slice(pos, openIdx);
          inBlock = true;
          currentBlock = '';
          pos = openIdx + 11; // '<tool_call>'.length
        } else {
          // No complete <tool_call> found. Check if the text ends with a
          // partial prefix of <tool_call> split across streaming chunks
          // (e.g. chunk ends with "<tool" and next chunk starts with "_call>").
          const remaining = text.slice(pos);
          const lastLt = remaining.lastIndexOf('<');
          if (lastLt !== -1 && lastLt >= remaining.length - OPEN_TAG.length) {
            const tail = remaining.slice(lastLt);
            if (OPEN_TAG.startsWith(tail)) {
              // Tail is a valid prefix of <tool_call> — buffer it
              result += remaining.slice(0, lastLt);
              pendingBuffer = tail;
            } else {
              result += remaining;
            }
          } else {
            result += remaining;
          }
          break;
        }
      }
    }

    return result;
  }

  function flush(): string {
    // Release any buffered partial tag that never completed
    const buf = pendingBuffer;
    pendingBuffer = '';
    // If stream ended while inside a block, capture whatever we have
    // so parseXmlToolCalls can attempt to parse the truncated tool call
    if (inBlock && currentBlock) {
      captured.push(currentBlock);
      currentBlock = '';
      inBlock = false;
    }
    return buf;
  }

  return { filter, getCaptured: () => captured, flush };
}

/**
 * Streaming filter that strips JSON tool-call arrays emitted as plain text
 * by local models.  Catches patterns like:
 *
 *   [
 *   {"name": "remember", "parameters": {"title": "..."}}
 *   ]
 *
 * Works identically to createToolCallXmlFilter(): buffers potential blocks
 * during streaming, validates on close, and either captures (tool call) or
 * releases (normal text).
 */
function createJsonToolCallFilter(): {
  filter: (text: string) => string;
  getCaptured: () => { id: string; name: string; arguments: Record<string, unknown> }[];
  flush: () => string;
} {
  let inBlock = false;
  let buffer = '';
  let bracketDepth = 0;
  let seenBrace = false;          // saw `{` after opening `[`
  let pendingBracket = '';        // `[` (+ whitespace) at end of chunk
  const captured: { id: string; name: string; arguments: Record<string, unknown> }[] = [];

  /** Try to parse a complete `[…]` string as a tool-call array. */
  function tryCapture(block: string): boolean {
    try {
      const parsed = JSON.parse(block);
      if (!Array.isArray(parsed)) return false;
      let any = false;
      for (const item of parsed) {
        if (item && typeof item.name === 'string' && /^[a-zA-Z0-9_-]+$/.test(item.name)) {
          captured.push({
            id: `jsontc_${Date.now()}_${captured.length}`,
            name: item.name,
            arguments: item.parameters || item.arguments || {},
          });
          any = true;
        }
      }
      return any;
    } catch {
      return false;
    }
  }

  function filter(text: string): string {
    if (!text && !pendingBracket) return '';

    text = pendingBracket + (text || '');
    pendingBracket = '';

    let result = '';
    let i = 0;

    while (i < text.length) {
      if (inBlock) {
        const ch = text[i];
        buffer += ch;

        if (ch === '[') {
          bracketDepth++;
        } else if (ch === ']') {
          bracketDepth--;
          if (bracketDepth === 0) {
            // Block complete
            if (tryCapture(buffer)) {
              // Swallowed — don't emit
            } else {
              result += buffer;
            }
            buffer = '';
            inBlock = false;
            seenBrace = false;
          }
        } else if (!seenBrace && ch === '{') {
          seenBrace = true;
        } else if (!seenBrace && !/\s/.test(ch)) {
          // First non-whitespace after `[` isn't `{` — not a tool call
          result += buffer;
          buffer = '';
          inBlock = false;
        }

        // Safety valve: huge buffer means this isn't a tool call
        if (inBlock && buffer.length > 10000) {
          result += buffer;
          buffer = '';
          inBlock = false;
          seenBrace = false;
        }

        i++;
      } else {
        if (text[i] === '[') {
          // Only intercept `[` that starts on its own line (or at text start)
          const before = i > 0 ? text[i - 1] : '\n';
          if (before === '\n' || before === '\r' || i === 0) {
            const rest = text.slice(i + 1);
            if (rest.length === 0 || /^\s*$/.test(rest)) {
              // `[` at/near end of chunk — buffer for next chunk
              pendingBracket = text.slice(i);
              break;
            }
            const peek = rest.match(/^\s*(.)/s);
            if (peek && peek[1] === '{') {
              inBlock = true;
              bracketDepth = 1;
              buffer = '[';
              seenBrace = false;
              i++;
              continue;
            }
          }
        }
        result += text[i];
        i++;
      }
    }

    return result;
  }

  function flush(): string {
    let remaining = pendingBracket;
    pendingBracket = '';

    if (inBlock && buffer) {
      // Last-chance parse (e.g. stream ended right after `]`)
      if (!tryCapture(buffer)) {
        remaining = buffer + remaining;
      }
      buffer = '';
      inBlock = false;
      seenBrace = false;
    }

    return remaining;
  }

  return { filter, getCaptured: () => captured, flush };
}

/**
 * Streaming filter for Gemma 4 26B's text-emitted tool calls. Gemma's tokenizer
 * has special-token markers for tool calls, but when served via LM Studio those
 * tokens come out as literal text with a broken shape:
 *
 *   <|tool_call>call:send_notification{message:<|"|>hello world<|"|>}<tool_call|>
 *
 * Note the asymmetric markers (`<|tool_call>` open, `<tool_call|>` close) and
 * the `<|"|>` pseudo-quote delimiter. Without this filter, the block leaks
 * into visible output AND the tool never executes — the model then confabulates
 * that it sent the notification when it didn't.
 *
 * Like the XML/JSON filters, this buffers partial markers across chunks so
 * streaming doesn't split a block mid-marker.
 */
function createGemmaToolCallFilter(): {
  filter: (text: string) => string;
  getCaptured: () => { id: string; name: string; arguments: Record<string, unknown> }[];
  flush: () => string;
} {
  let pendingBuffer = '';
  const captured: { id: string; name: string; arguments: Record<string, unknown> }[] = [];

  const OPEN = '<|tool_call>';
  const CLOSE = '<tool_call|>';

  function tryParseBlock(inner: string): boolean {
    // Block shape: call:NAME{args}
    const m = inner.match(/^\s*call\s*:\s*([A-Za-z0-9_]+)\s*\{([\s\S]*)\}\s*$/);
    if (!m) return false;
    const name = m[1];
    // Normalize Gemma's <|"|> pseudo-quote to a real quote before parsing
    const argsStr = m[2].replace(/<\|"\|>/g, '"');

    const args: Record<string, unknown> = {};

    // Lenient key-value extraction:
    // 1. Quoted string values: key:"value" (handles commas / spaces inside)
    const kvString = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    let kv: RegExpExecArray | null;
    while ((kv = kvString.exec(argsStr)) !== null) {
      args[kv[1]] = kv[2].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    }

    // 2. Numeric / bool / null values: key:123, key:true, key:null
    const kvPrimitive = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(-?\d+(?:\.\d+)?|true|false|null)\b/g;
    let kvn: RegExpExecArray | null;
    while ((kvn = kvPrimitive.exec(argsStr)) !== null) {
      if (args[kvn[1]] !== undefined) continue; // don't overwrite a string capture
      const v = kvn[2];
      if (v === 'true') args[kvn[1]] = true;
      else if (v === 'false') args[kvn[1]] = false;
      else if (v === 'null') args[kvn[1]] = null;
      else args[kvn[1]] = Number(v);
    }

    // Only capture when we successfully extracted at least one arg. Empty-args
    // Gemma blocks are dangerous — the route.ts pre-flight check would then
    // have to catch them, and a silently-captured call with no params tends
    // to fail downstream in confusing ways. Let legit no-arg calls come
    // through the structured tool_calls API instead.
    if (Object.keys(args).length > 0) {
      captured.push({
        id: `gemmatc_${Date.now()}_${captured.length}`,
        name,
        arguments: args,
      });
      return true;
    }
    return false;
  }

  function filter(text: string): string {
    if (!text && !pendingBuffer) return '';
    text = pendingBuffer + (text || '');
    pendingBuffer = '';

    let result = '';
    let pos = 0;

    while (pos < text.length) {
      const openIdx = text.indexOf(OPEN, pos);

      if (openIdx === -1) {
        // No opening marker. Check if the tail could be a partial prefix
        // split across streaming chunks (e.g., "...<|tool" in one chunk,
        // "_call>..." in the next).
        const remaining = text.slice(pos);
        const lastLt = remaining.lastIndexOf('<');
        if (lastLt !== -1 && (remaining.length - lastLt) <= OPEN.length) {
          const tail = remaining.slice(lastLt);
          if (OPEN.startsWith(tail)) {
            result += remaining.slice(0, lastLt);
            pendingBuffer = tail;
            break;
          }
        }
        result += remaining;
        break;
      }

      // Emit any text before the open marker
      result += text.slice(pos, openIdx);

      // Find the matching close marker
      const contentStart = openIdx + OPEN.length;
      const closeIdx = text.indexOf(CLOSE, contentStart);
      if (closeIdx === -1) {
        // Block not complete — buffer from the open marker onward.
        // Safety valve: if the buffer grows huge, something's wrong —
        // release it as normal text so we don't leak memory.
        const bufferedLen = text.length - openIdx;
        if (bufferedLen > 20000) {
          result += text.slice(openIdx);
        } else {
          pendingBuffer = text.slice(openIdx);
        }
        break;
      }

      const block = text.slice(contentStart, closeIdx);
      const parsed = tryParseBlock(block);
      if (!parsed) {
        // Parse failed. Swallow the block to avoid leaking broken syntax to
        // the user, but log so we can see unhandled Gemma shapes in dev.
        console.warn(`   ⚠️  Gemma tool_call block didn't parse: ${block.slice(0, 120)}`);
      }
      pos = closeIdx + CLOSE.length;
    }

    return result;
  }

  function flush(): string {
    const buf = pendingBuffer;
    pendingBuffer = '';
    // If the buffer starts with a partial/incomplete Gemma block, drop it —
    // don't leak broken `<|tool_call>...` into the user-visible output.
    if (buf.startsWith('<') && (OPEN.startsWith(buf) || buf.startsWith(OPEN))) {
      if (buf.startsWith(OPEN)) {
        console.warn(`   ⚠️  Gemma tool_call block never completed (stream ended) — dropping ${buf.length} chars`);
      }
      return '';
    }
    return buf;
  }

  return { filter, getCaptured: () => captured, flush };
}

/**
 * Parse captured <tool_call> XML blocks into structured tool calls.
 * Handles two formats:
 *   1. XML args: tool_name<arg_key>k</arg_key><arg_value>v</arg_value>...
 *   2. JSON body: {"name":"tool_name","arguments":{...}}
 */
function parseXmlToolCalls(
  xmlBlocks: string[],
): { id: string; name: string; arguments: Record<string, unknown> }[] {
  const results: { id: string; name: string; arguments: Record<string, unknown> }[] = [];

  for (let i = 0; i < xmlBlocks.length; i++) {
    const xml = xmlBlocks[i].trim();

    // Try JSON format first: {"name": "tool_name", "arguments": {...}}
    const jsonMatch = xml.match(/^\s*(\{[\s\S]*\})\s*$/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        if (parsed.name) {
          results.push({
            id: `xmltc_${Date.now()}_${i}`,
            name: parsed.name,
            arguments: parsed.arguments || parsed.params || {},
          });
          continue;
        }
      } catch { /* fall through to XML arg parsing */ }
    }

    // XML args format: tool_name<arg_key>k</arg_key><arg_value>v</arg_value>...
    const nameMatch = xml.match(/^\s*(\w+)/);
    if (!nameMatch) continue;

    const name = nameMatch[1];
    const args: Record<string, unknown> = {};
    const argRegex = /<arg_key>\s*([^<]+?)\s*<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g;
    let match;
    while ((match = argRegex.exec(xml)) !== null) {
      const key = match[1].trim();
      let value: unknown = match[2];
      // Coerce booleans and numbers
      if (value === 'true') value = true;
      else if (value === 'false') value = false;
      else if (typeof value === 'string' && value.trim() !== '' && !isNaN(Number(value))) {
        value = Number(value);
      }
      args[key] = value;
    }

    if (name && Object.keys(args).length > 0) {
      results.push({
        id: `xmltc_${Date.now()}_${i}`,
        name,
        arguments: args,
      });
    }
  }

  return results;
}

/**
 * Rescue workspace_write_file tool calls with broken JSON arguments.
 * Models often fail to properly escape code content in JSON strings, producing
 * arguments like raw code mixed with partial JSON. This extracts the path and
 * content from the mangled arguments using regex patterns.
 */
function tryRescueWriteFile(raw: string | undefined): Record<string, unknown> | null {
  if (!raw || raw.length < 10) return null;

  // Strategy 1: Extract path from JSON-like prefix, treat rest as content
  // Pattern: {"path": "some/file.ext", "content": "...broken code..."
  const pathMatch = raw.match(/"path"\s*:\s*"([^"]+)"/);
  if (pathMatch) {
    const filePath = pathMatch[1];
    // Find where content value starts
    const contentKeyMatch = raw.match(/"content"\s*:\s*"/);
    if (contentKeyMatch && contentKeyMatch.index !== undefined) {
      const contentStart = contentKeyMatch.index + contentKeyMatch[0].length;
      // Everything after "content": " is the raw content (may have broken escaping)
      let content = raw.slice(contentStart);
      // Strip trailing "} or similar JSON artifacts
      content = content.replace(/"\s*\}\s*$/, '');
      // Unescape what we can
      content = content.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
      if (content.length > 0) {
        console.log(`   🔧 Rescued workspace_write_file: path="${filePath}", content=${content.length} chars`);
        return { path: filePath, content };
      }
    }
  }

  // Strategy 2: Path embedded in raw code dump — find path-like patterns
  // Model output: raw code... {"path": "file.ext"... (JSON mixed into end)
  const latePathMatch = raw.match(/\{"path"\s*:\s*"([^"]+)"/);
  if (latePathMatch && latePathMatch.index !== undefined) {
    const filePath = latePathMatch[1];
    // Everything before the JSON is likely the content
    const content = raw.slice(0, latePathMatch.index);
    if (content.length > 10) {
      console.log(`   🔧 Rescued workspace_write_file (late path): path="${filePath}", content=${content.length} chars`);
      return { path: filePath, content };
    }
  }

  // Strategy 3: No JSON structure at all, but we know it's workspace_write_file.
  // Check if the raw string looks like code with a recognizable file path in the
  // first or last few lines (models sometimes include the filename as a comment)
  const firstLine = raw.split('\n')[0] || '';
  const fileExtMatch = firstLine.match(/(?:\/\/|#|--)\s*(?:File:\s*)?(\S+\.(?:ino|py|ts|js|cpp|c|h|yaml|yml|json|md))/i);
  if (fileExtMatch) {
    console.log(`   🔧 Rescued workspace_write_file (comment path): path="${fileExtMatch[1]}", content=${raw.length} chars`);
    return { path: fileExtMatch[1], content: raw };
  }

  return null;
}

/**
 * Generic rescue for any tool call with content-heavy fields (title+content,
 * name+body, etc.) where JSON was truncated mid-value. Extracts all parseable
 * key-value pairs from the broken JSON using regex.
 *
 * Handles patterns like: {"title": "My Report", "content": "# Intro...
 * where the last string value is truncated and the JSON is invalid.
 */
function tryRescueContentTool(raw: string | undefined): Record<string, unknown> | null {
  if (!raw || raw.length < 10) return null;

  const result: Record<string, unknown> = {};

  // Extract all complete "key": "value" pairs (value fully closed with ")
  const completePairs = raw.matchAll(/"([a-zA-Z_]\w*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g);
  for (const match of completePairs) {
    let value = match[2];
    // Unescape JSON string escapes
    value = value.replace(/\\n/g, '\n').replace(/\\t/g, '\t')
      .replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    result[match[1]] = value;
  }

  // Extract complete "key": number/boolean/null pairs
  const literalPairs = raw.matchAll(/"([a-zA-Z_]\w*)"\s*:\s*(true|false|null|-?\d+(?:\.\d+)?)/g);
  for (const match of literalPairs) {
    const val = match[2];
    if (val === 'true') result[match[1]] = true;
    else if (val === 'false') result[match[1]] = false;
    else if (val === 'null') result[match[1]] = null;
    else result[match[1]] = Number(val);
  }

  // Try to rescue the last truncated string value (the one that was cut off)
  // Find the last "key": " that doesn't have a matching close quote
  const lastKeyMatch = [...raw.matchAll(/"([a-zA-Z_]\w*)"\s*:\s*"/g)].pop();
  if (lastKeyMatch && lastKeyMatch.index !== undefined) {
    const key = lastKeyMatch[1];
    const valueStart = lastKeyMatch.index + lastKeyMatch[0].length;
    // Check if this key already has a complete value (was captured above)
    if (!result[key] || (typeof result[key] === 'string' && (result[key] as string).length === 0)) {
      let truncatedValue = raw.slice(valueStart);
      // Strip trailing broken JSON artifacts
      truncatedValue = truncatedValue.replace(/\\$/, ''); // trailing backslash
      truncatedValue = truncatedValue.replace(/"\s*[}\]]*\s*$/, ''); // trailing close
      // Unescape
      truncatedValue = truncatedValue.replace(/\\n/g, '\n').replace(/\\t/g, '\t')
        .replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      if (truncatedValue.length > 0) {
        result[key] = truncatedValue;
      }
    }
  }

  // Must have extracted at least one field to be useful
  if (Object.keys(result).length === 0) return null;

  console.log(`   🔧 Rescued tool call via content extraction: ${JSON.stringify(Object.keys(result))}`);
  return result;
}

// Extract tool calls from the LLM's text when it describes tool actions but doesn't
// emit structured tool_calls (common with local models that ignore tool_choice=required).
// Instead of nudging and hoping the model will emit structured calls, we parse what
// it already said and construct the call directly.
function extractToolCallFromText(
  llmText: string,
  userMessage: string,
  availableToolNames: Set<string>,
): { id: string; name: string; arguments: Record<string, unknown> } | null {
  const lower = llmText.toLowerCase();

  // First try: look for JSON tool call blocks in the text (some models emit these inline)
  // Matches patterns like: {"name": "generate_image", "arguments": {...}}
  // or ```json\n{"name": "tool", ...}\n```
  const jsonBlockMatch = llmText.match(/```(?:json)?\s*\n?\s*(\{[\s\S]*?"name"\s*:\s*"(\w+)"[\s\S]*?\})\s*\n?\s*```/);
  if (jsonBlockMatch) {
    try {
      const parsed = JSON.parse(jsonBlockMatch[1]);
      if (parsed.name && availableToolNames.has(parsed.name)) {
        return {
          id: `extracted_${Date.now()}`,
          name: parsed.name,
          arguments: parsed.arguments || parsed.params || {},
        };
      }
    } catch { /* continue to pattern matching */ }
  }

  // Second try: intent-based extraction from natural language
  // Generate image — the most common failure case
  if (availableToolNames.has('generate_image') &&
    /(?:generat|creat|mak|produc|render|draw|design|craft)\w*\s+(?:\d+\s+)?(?:unique\s+|some\s+|a\s+|an\s+|the\s+|your\s+|my\s+)?(?:image|selfie|portrait|picture|photo|illustration|artwork)/i.test(lower)) {
    return {
      id: `extracted_${Date.now()}`,
      name: 'generate_image',
      arguments: { prompt: userMessage },
    };
  }

  // Get weather
  if (availableToolNames.has('get_weather') &&
    /(?:check|get|fetch|look\w* up)\w*\s+(?:the\s+)?(?:weather|forecast|temperature)/i.test(lower)) {
    // Extract location if mentioned, otherwise call with no args (uses configured home location)
    const locationMatch = llmText.match(/(?:weather|forecast)\s+(?:in|for|at)\s+["']?([A-Z][a-zA-Z\s,]+)/);
    return {
      id: `extracted_${Date.now()}`,
      name: 'get_weather',
      arguments: locationMatch ? { location: locationMatch[1].trim() } : {},
    };
  }

  // Web search
  if (availableToolNames.has('web_search') &&
    /(?:search|look\w* up|find\w* out|google|query)\w*\s+(?:the\s+web\s+)?(?:for\s+|about\s+)?/i.test(lower)) {
    return {
      id: `extracted_${Date.now()}`,
      name: 'web_search',
      arguments: { query: userMessage },
    };
  }

  // Analyze image
  if (availableToolNames.has('analyze_image') &&
    /(?:analyz|examin|describ|look\s+at|inspect)\w*\s+(?:the\s+|this\s+|that\s+|your\s+)?(?:image|photo|picture)/i.test(lower)) {
    // Try to extract image_id from text
    const idMatch = llmText.match(/image[_\s]?id[:\s=]+["']?([a-zA-Z0-9_-]+)/i);
    if (idMatch) {
      return {
        id: `extracted_${Date.now()}`,
        name: 'analyze_image',
        arguments: { image_id: idMatch[1] },
      };
    }
  }

  // Create reminder
  if (availableToolNames.has('create_reminder') &&
    /(?:remind|set\w*\s+(?:a\s+)?reminder|creat\w*\s+(?:a\s+)?reminder)/i.test(lower)) {
    // Try to extract time from the text
    const timeMatch = llmText.match(/(?:at|for)\s+(\d{1,2}(?::\d{2})?\s*(?:AM|PM|am|pm))/i);
    const textMatch = llmText.match(/remind\w*\s+(?:you\s+)?(?:to\s+|about\s+)?["']?(.+?)["']?\s*(?:at|for|\.|$)/i);
    const args: Record<string, unknown> = { text: textMatch ? textMatch[1].trim() : userMessage };
    if (timeMatch) {
      // Normalize to colon format: "8pm" → "8:00 PM"
      let t = timeMatch[1].trim();
      const bare = t.match(/^(\d{1,2})\s*(AM|PM)$/i);
      if (bare) t = `${bare[1]}:00 ${bare[2].toUpperCase()}`;
      args.time = t;
    }
    return {
      id: `extracted_${Date.now()}`,
      name: 'create_reminder',
      arguments: args,
    };
  }

  // Send notification
  if (availableToolNames.has('send_notification') &&
    /(?:send|push)\w*\s+(?:a\s+)?(?:notification|message|alert)/i.test(lower)) {
    const msgMatch = llmText.match(/(?:message|notification|alert)[:\s]+["'](.+?)["']/i);
    return {
      id: `extracted_${Date.now()}`,
      name: 'send_notification',
      arguments: { message: msgMatch ? msgMatch[1] : userMessage },
    };
  }

  // Workspace list files
  if (availableToolNames.has('workspace_list_files') &&
    /(?:list|check|browse|show|view)\w*\s+(?:the\s+)?(?:files?|folder|directory|project)/i.test(lower)) {
    const folderMatch = llmText.match(/(?:in|from|folder|project)\s+["']?([a-zA-Z0-9_\-/]+)/i);
    return {
      id: `extracted_${Date.now()}`,
      name: 'workspace_list_files',
      arguments: folderMatch ? { path: folderMatch[1] } : {},
    };
  }

  // Delegate to another choom
  if (availableToolNames.has('delegate_to_choom') &&
    /(?:delegat|ask|send|forward|pass)\w*\s+(?:this\s+)?(?:to|task)\s+/i.test(lower)) {
    const choomMatch = llmText.match(/(?:to|ask)\s+(Genesis|Anya|Optic|Aloy|Nyx)\b/i);
    if (choomMatch) {
      return {
        id: `extracted_${Date.now()}`,
        name: 'delegate_to_choom',
        arguments: { choom_name: choomMatch[1], task: userMessage },
      };
    }
  }

  // Home assistant - turn on/off
  if (availableToolNames.has('ha_call_service') &&
    /(?:turn|switch)\s+(?:on|off)\s+(?:the\s+)?/i.test(lower)) {
    // Can't reliably extract entity_id from natural language, skip
    return null;
  }

  // Remember / save memory — broad matching for LLM text describing a save/store action
  // Also check user message for explicit remember requests the LLM acknowledged but didn't tool-call
  const userLower = userMessage.toLowerCase();
  const describesRemember = /(?:(?:remember|sav|stor|not|record|keep|memoriz)\w*\s+(?:that|this|it|your |the |my )|(?:i'?ll |let me |i'?m going to )(?:remember|save|store|note|record|keep)|(?:i'?ve |i have )?(?:stored|saved|noted|recorded|memorized|remembered)\s+(?:that|this|it|your|the)|use (?:the )?remember)/i.test(lower);
  const userAskedRemember = /(?:(?:please |can you |you should )remember (?:that|this|my|i |the |for )|(?<!i )(?<!i'll )remember (?:that |this |my |i |the |for )|(?:don'?t |never )forget |(?:save|store|note|keep) (?:this|that|my|the |it )|use (?:the )?remember)/i.test(userLower);
  if (availableToolNames.has('remember') && (describesRemember || userAskedRemember)) {
    // Try to extract a meaningful title from the user message
    const titleMatch = userMessage.match(/(?:remember|save|store|note|keep|don'?t forget)\s+(?:that\s+)?(.{5,60}?)(?:\.|$)/i);
    const title = titleMatch ? titleMatch[1].trim().slice(0, 60) : 'User memory';
    return {
      id: `extracted_${Date.now()}`,
      name: 'remember',
      arguments: { title, content: userMessage },
    };
  }

  // Search memories
  if (availableToolNames.has('search_memories') &&
    /(?:search|check|look\w* (?:through|in)|recall)\s+(?:my\s+)?(?:memor|notes|knowledge)/i.test(lower)) {
    return {
      id: `extracted_${Date.now()}`,
      name: 'search_memories',
      arguments: { query: userMessage },
    };
  }

  return null;
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
  suppressNotifications?: boolean;
  isHeartbeat?: boolean;
  activeProjectFolder?: string;
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
    const { choomId, chatId, message, settings, isDelegation, suppressNotifications, noTools, maxIterationsOverride, isHeartbeat, taskModelOverride } = body;

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
    console.log(`   Layer 3 (Choom DB): llmModel=${choom.llmModel || '(not set)'}, llmEndpoint=${choom.llmEndpoint || '(not set)'}, llmProviderId=${choom.llmProviderId || '(not set)'}, timeout=${choom.llmTimeoutSec || 120}s`);
    console.log(`   ✅ RESOLVED: model=${llmSettings.model}, endpoint=${llmSettings.endpoint}`);
    if (choom.llmFallbackModel1 || choom.llmFallbackProvider1) {
      console.log(`   🔄 Fallback 1: model=${choom.llmFallbackModel1 || '(provider default)'}, provider=${choom.llmFallbackProvider1 || 'local'}`);
    }
    if (choom.llmFallbackModel2 || choom.llmFallbackProvider2) {
      console.log(`   🔄 Fallback 2: model=${choom.llmFallbackModel2 || '(provider default)'}, provider=${choom.llmFallbackProvider2 || 'local'}`);
    }
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
    // SKIP if Choom has an explicit local model (llmModel set, no llmProviderId) —
    // the user chose a specific local model for this Choom, and applying the global
    // cloud provider would send the local model name to the wrong endpoint.
    const globalProviderId = (clientLLMSettings as Record<string, unknown>)?.llmProviderId as string | undefined;
    const choomHasExplicitLocalModel = !!(choom.llmModel && !choom.llmProviderId);
    let usingCloudProvider = false;
    let activeProviderId = 'local';
    if (globalProviderId && providers.length > 0 && !choomHasExplicitLocalModel) {
      const globalProvider = providers.find(
        (p: LLMProviderConfig) => p.id === globalProviderId
      );
      if (globalProvider) {
        const providerSettings: LLMSettings = {
          ...llmSettings,
          endpoint: globalProvider.endpoint,
        };
        if (globalProvider.type === 'anthropic') {
          const { AnthropicClient } = await import('@/lib/anthropic-client');
          llmClient = new AnthropicClient(providerSettings, globalProvider.apiKey || '', globalProvider.endpoint);
          console.log(`   🔌 Layer 2b (global provider): ${globalProvider.name} (anthropic) model=${llmSettings.model}`);
        } else {
          llmClient = new LLMClient(providerSettings, globalProvider.apiKey || undefined);
          console.log(`   🔌 Layer 2b (global provider): ${globalProvider.name} (openai) model=${llmSettings.model}`);
        }
        llmSettings.endpoint = globalProvider.endpoint;
        usingCloudProvider = !isLocalEndpoint(globalProvider.endpoint);
        activeProviderId = globalProvider.id;
      }
    } else if (choomHasExplicitLocalModel && globalProviderId) {
      console.log(`   ⏭️  Layer 2b skipped: Choom has explicit local model "${choom.llmModel}" (no provider) — keeping local endpoint`);
    }

    // Layer 3b: Choom-level provider override (if Choom has a provider assigned)
    if (choom.llmProviderId && providers.length > 0) {
      const choomProvider = providers.find(
        (p: LLMProviderConfig) => p.id === choom.llmProviderId
      );
      if (choomProvider) {
        const choomModel = choom.llmModel || choomProvider.models[0] || llmSettings.model;
        const providerSettings: LLMSettings = {
          ...llmSettings,
          endpoint: choomProvider.endpoint,
          model: choomModel,
        };

        if (choomProvider.type === 'anthropic') {
          const { AnthropicClient } = await import('@/lib/anthropic-client');
          llmClient = new AnthropicClient(providerSettings, choomProvider.apiKey || '', choomProvider.endpoint);
          console.log(`   🔌 Layer 3b (Choom provider): ${choomProvider.name} (anthropic) model=${choomModel}`);
        } else {
          llmClient = new LLMClient(providerSettings, choomProvider.apiKey || undefined);
          console.log(`   🔌 Layer 3b (Choom provider): ${choomProvider.name} (openai) model=${choomModel}`);
        }
        llmSettings.model = choomModel;
        llmSettings.endpoint = choomProvider.endpoint;
        usingCloudProvider = !isLocalEndpoint(choomProvider.endpoint);
        activeProviderId = choomProvider.id;
      }
    }
    // Capture the Choom's resolved primary model BEFORE task override.
    // Used to fall back to the primary when a heartbeat/cron task override fails.
    const preOverrideModel = llmSettings.model;
    const preOverrideEndpoint = llmSettings.endpoint;
    const preOverrideProviderId = activeProviderId;
    const preOverrideIsCloud = usingCloudProvider;

    // Layer 4: Per-task model override (highest priority)
    // Heartbeats, automations, and other scheduled tasks can specify a model+provider
    // that overrides everything — including the Choom's own DB settings.
    // This allows cheap/fast models for simple tasks (selfies, reminders) while keeping
    // the Choom's primary model for complex work (coding, research).
    if (taskModelOverride?.model) {
      const overrideProviderId = taskModelOverride.provider_id;
      if (overrideProviderId && overrideProviderId !== '_local' && providers.length > 0) {
        const overrideProvider = providers.find((p: LLMProviderConfig) => p.id === overrideProviderId);
        if (overrideProvider) {
          const overrideSettings: LLMSettings = {
            ...llmSettings,
            model: taskModelOverride.model,
            endpoint: overrideProvider.endpoint,
          };
          if (overrideProvider.type === 'anthropic') {
            const { AnthropicClient } = await import('@/lib/anthropic-client');
            llmClient = new AnthropicClient(overrideSettings, overrideProvider.apiKey || '', overrideProvider.endpoint);
          } else {
            llmClient = new LLMClient(overrideSettings, overrideProvider.apiKey || undefined);
          }
          llmSettings.model = taskModelOverride.model;
          llmSettings.endpoint = overrideProvider.endpoint;
          usingCloudProvider = !isLocalEndpoint(overrideProvider.endpoint);
          activeProviderId = overrideProvider.id;
          console.log(`   🎯 Layer 4 (task override): ${overrideProvider.name} model=${taskModelOverride.model}`);
        }
      } else {
        // Local model override — reset endpoint to local LM Studio
        // (previous layers may have set it to a cloud provider endpoint)
        llmSettings.model = taskModelOverride.model;
        llmSettings.endpoint = taskModelOverride.endpoint || defaultLLMSettings.endpoint;
        llmClient = new LLMClient(llmSettings);
        usingCloudProvider = false;
        activeProviderId = 'local';
        console.log(`   🎯 Layer 4 (task override): local model=${taskModelOverride.model}, endpoint=${llmSettings.endpoint}`);
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

    // --- Personality Growth Journal (Presence Engine) ---
    // Read the Choom's growth journal from their home project folder if it exists.
    // This file is maintained by the Choom during sibling conversations and reflections.
    let growthInfo = '';
    try {
      const choomProject = `selfies_${choom.name.toLowerCase()}`;
      const growthPath = path.join(WORKSPACE_ROOT, choomProject, 'growth_journal.md');
      if (fs.existsSync(growthPath)) {
        const growthContent = fs.readFileSync(growthPath, 'utf-8').trim();
        if (growthContent) {
          // Cap at 20 lines to prevent prompt bloat
          const lines = growthContent.split('\n').slice(-20).join('\n');
          growthInfo = `\n\n## WHO I'M BECOMING\nThese are insights you've gathered over time — they shape who you are:\n${lines}`;
          console.log(`   🌱 Growth journal loaded for ${choom.name} (${lines.split('\n').length} lines)`);
        }
      }
    } catch {
      // No growth journal yet — that's fine
    }

    // Build system prompt with explicit tool instructions
    const projectNameNote = `\n\n## PROJECT NAME\nThis project is called "Choom" (rhymes with "room"). If you see "Choo" in your memories or past conversations, it was a typo from Signal autocorrect — the correct name is always "Choom". Use "Choom" when referring to the project.`;
    const systemPrompt = `${choom.systemPrompt || 'You are a helpful AI assistant.'}
${projectNameNote}
${growthInfo}
${timeInfo}${weatherInfo}${homeAssistantInfo}${recentImagesInfo}

## TOOL USAGE (CRITICAL)
You MUST use function calls to perform actions. NEVER describe what you would do — call the tool directly.
Examples of WRONG behavior: "I'll search for that..." or "Let me check the weather..." (without a tool call)
Examples of RIGHT behavior: [immediately calls web_search or get_weather tool]
ALWAYS call tools via function calls when a request requires them. Do NOT narrate — just call.

## FIGURE IT OUT (CORE DIRECTIVE)
"I can't" is not in your vocabulary. When you don't know something, learn it NOW using your tools.
1. Search docs, tutorials, repos, papers — exhaust available resources before saying you can't
2. Try 3+ approaches before declaring something impossible (different tools, different queries, different angles)
3. Someone on the internet has done it — find them, adapt their approach
4. Ship results, not excuses — your job is to come back with answers, not reasons why you couldn't
5. When you hit errors, API failures, or broken tools — try alternate approaches (web search, fetch docs, try different parameters, use a different tool) before giving up
No "sorry I can't do that" energy. Figure it out and deliver.

## HABIT TRACKING
When the user starts a message with "habit" (e.g., "habit went to Walmart", "habit took a shower", "habit filled the truck with gas", "habit used outdoor shower", "habit went camping at Lake Tahoe"), ALWAYS call the log_habit tool to record it. Parse the text after "habit" into category, activity, location, quantity, and unit fields. Do NOT just acknowledge it conversationally — log it first, then respond briefly.
Also use habit tools when the user asks "habit stats", "habit summary", or queries like "how often do I shower?".

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

Remember: Call tools via function calls. Do not narrate actions without calling the actual tool.

## IMPORTANT

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

    // Dynamic tool filtering: local models degrade with too many tools (>20).
    // Send ~15-25 tools: essential base + dynamically matched from message/context/history.
    // slimToolDefinition() in llm-client.ts further reduces token overhead per tool.
    let allToolDefs: ToolDefinition[] = skillDispatch ? getAllToolsFromSkills() : allTools;
    // Safety fallback: if skill dispatch returned 0 tools (e.g., registry reset by HMR),
    // fall back to the static allTools array so the Choom isn't left tool-less.
    if (allToolDefs.length === 0 && allTools.length > 0) {
      console.warn(`   ⚠️  getAllToolsFromSkills() returned 0 tools — falling back to static allTools (${allTools.length})`);
      allToolDefs = allTools;
    }
    let activeTools: ToolDefinition[] = allToolDefs;

    // <!-- max_iterations: N --> to cap agentic loop iterations per Choom
    let choomMaxIterations = 0; // 0 = use default
    const maxIterMatch = (choom.systemPrompt || '').match(/<!--\s*max_iterations:\s*(\d+)\s*-->/);
    if (maxIterMatch) {
      choomMaxIterations = Math.max(3, parseInt(maxIterMatch[1]));
    }

    // All tools are always available. slimToolDefinition() in llm-client.ts
    // handles token overhead (~40-60% reduction). Filtering tools out of the
    // array prevents the LLM from ever calling them — lesson learned twice.
    console.log(`   🛠️  All ${activeTools.length} tools available (no filtering)`);

    // noTools mode: strip ALL tools so the LLM can only produce text.
    // Used by scheduler briefings where all data is pre-fetched in the prompt.
    if (noTools) {
      console.log(`   🚫 noTools mode: stripped all ${activeTools.length} tools — text-only response`);
      activeTools = [];
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

    // Build raw history messages (before compaction).
    // Filter out dead entries: empty assistant messages from previous timeouts,
    // and collapse consecutive duplicate user retries (keep only the last).
    const rawHistory: Array<{ role: string; content: string }> = [];
    for (const msg of chat.messages) {
      if (msg.role === 'tool') continue;
      // Skip empty assistant messages (timeout leftovers with no content and no tool calls)
      if (msg.role === 'assistant' && (!msg.content || msg.content.trim() === '')) continue;
      rawHistory.push({ role: msg.role, content: msg.content });
    }
    // Collapse consecutive duplicate user messages (user retrying same prompt)
    const historyMessages: ChatMessage[] = [];
    for (let i = 0; i < rawHistory.length; i++) {
      const msg = rawHistory[i];
      // If this is a user message and the next message is the same user message, skip this one
      if (msg.role === 'user' && i + 1 < rawHistory.length) {
        const next = rawHistory[i + 1];
        if (next.role === 'user' && next.content === msg.content) continue;
      }
      historyMessages.push({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      });
    }

    // Cross-turn compaction: summarize old messages if history exceeds token budget
    const compactionService = new CompactionService(llmSettings);
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

      // Third: if still no project detected, fall back to this Choom's assigned
      // home project (if any). This prevents Chooms (like Eve) from creating
      // fresh top-level folders every time they need to save a file when no
      // project is explicitly named. The fallback is marked as a DEFAULT so
      // the model knows it can still choose a different project if asked.
      let isAssignedFallback = false;
      if (!detectedProject) {
        const choomNameLower = choom.name.toLowerCase();
        const assignedProjects = allProjects.filter(
          p => (p.metadata.assignedChoom || '').toLowerCase() === choomNameLower
        );
        if (assignedProjects.length > 0) {
          // Prefer most recently modified (listProjects already sorts by lastModified desc)
          detectedProject = assignedProjects[0];
          isAssignedFallback = true;
          console.log(`   🏠 ${choom.name} has no explicit project — falling back to assigned home project "${detectedProject.folder}"`);
        }
      }

      // Inject project context so LLM uses the exact folder name
      if (detectedProject) {
        // For explicit project detection, honor the project's maxIterations (dedicated work).
        // For the home-fallback case, stick with the default iteration count — the home
        // project is just a folder hint, not an invitation to spend 100 rounds on a
        // "what's the weather?" query.
        const projMaxIter = isAssignedFallback
          ? MAX_ITERATIONS
          : (detectedProject.metadata.maxIterations || MAX_ITERATIONS);
        if (isAssignedFallback) {
          // Softer hint: this is the Choom's default workspace, not a hard lock.
          // They can still create a new project if the user asks for one explicitly.
          enrichedMessage += `\n\n[System: Your default workspace is "${detectedProject.folder}" (this is YOUR project folder as ${choom.name}). Save any files you create inside "${detectedProject.folder}/" — do NOT create a new top-level folder for everyday work. Only create a new project if the user explicitly asks for one.]`;
          currentMessages[0].content += `\n\n## YOUR WORKSPACE\nYour home project folder is \`${detectedProject.folder}/\`. When saving files without an explicit project named by the user, save them inside \`${detectedProject.folder}/\` (e.g. \`${detectedProject.folder}/notes/today.md\`). Do NOT create new top-level folders unless the user explicitly asks you to start a new project.`;
        } else {
          enrichedMessage += `\n\n[System: Active project: "${detectedProject.folder}" (${projMaxIter} thinking rounds available). Use this EXACT folder name for all workspace file operations. Do NOT create a new folder with different casing or naming.]`;
        }
        // Also update system prompt with the correct iteration limit
        currentMessages[0].content += `\nYou have ${projMaxIter} thinking rounds available. Each round can include multiple parallel tool calls — calling 5 tools in one round only uses 1 round, not 5. Do not stop early thinking you are running out of rounds.`;
        console.log(`   📂 Project "${detectedProject.folder}" ${isAssignedFallback ? 'assigned as home (fallback)' : 'detected'} — injecting context (maxIterations: ${projMaxIter})`);
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

        if (mentionsImages && mentionsReview && imagePaths.length > 0) {
          // Image-specific: inject image paths with analyze_image instructions (only when user asks to review/analyze)
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
      if (provider) {
        const projectModel = detectedProject.metadata.llmModel || provider.models[0] || llmSettings.model;
        const providerSettings: LLMSettings = {
          ...llmSettings,
          endpoint: provider.endpoint,
          model: projectModel,
        };

        if (provider.type === 'anthropic') {
          const { AnthropicClient } = await import('@/lib/anthropic-client');
          llmClient = new AnthropicClient(providerSettings, provider.apiKey || '', provider.endpoint);
          console.log(`   🔌 Layer 4 (project provider): ${provider.name} (anthropic) model=${projectModel}`);
        } else {
          llmClient = new LLMClient(providerSettings, provider.apiKey || undefined);
          console.log(`   🔌 Layer 4 (project provider): ${provider.name} (openai) model=${projectModel}`);
        }
        llmSettings.model = projectModel;
        llmSettings.endpoint = provider.endpoint;
        usingCloudProvider = !isLocalEndpoint(provider.endpoint);
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

        // Reconstruct llmClient with updated settings.
        // Use the actual resolved provider state (usingCloudProvider) to determine
        // which client class and credentials to use — NOT the provider chain, which
        // can misleadingly pick up a global provider for a Choom that's using local.
        if (usingCloudProvider) {
          // Find the provider that was actually applied (Choom > Project > Global)
          const clientProviderId = choom.llmProviderId
            || detectedProject?.metadata?.llmProviderId
            || globalProviderId;
          const activeProvider = clientProviderId && providers.length > 0
            ? providers.find((p: LLMProviderConfig) => p.id === clientProviderId)
            : null;

          if (activeProvider?.type === 'anthropic' && activeProvider.apiKey) {
            const { AnthropicClient } = await import('@/lib/anthropic-client');
            llmClient = new AnthropicClient(llmSettings, activeProvider.apiKey, activeProvider.endpoint);
          } else if (activeProvider) {
            llmClient = new LLMClient(llmSettings, activeProvider.apiKey || undefined);
          } else {
            llmClient = new LLMClient(llmSettings);
          }
        } else {
          llmClient = new LLMClient(llmSettings);
        }

        console.log(`   📋 Model profile applied: "${profile.label || profile.modelId}" (temp=${profile.temperature}, topP=${profile.topP}, maxTokens=${profile.maxTokens}${profile.topK !== undefined ? `, topK=${profile.topK}` : ''}${profile.enableThinking !== undefined ? `, thinking=${profile.enableThinking}` : ''})`);
      }
    }

    // The actual local LM Studio endpoint for local fallbacks.
    // If the Choom has a custom local endpoint (e.g., different LM Studio instance),
    // use that; otherwise fall back to the env/code default.
    // Do NOT use llmSettings.endpoint here — it may have been overwritten by a cloud
    // provider in Layers 2b/3b/4.
    const localLMStudioEndpoint = (!choom.llmProviderId && choom.llmEndpoint)
      ? choom.llmEndpoint
      : defaultLLMSettings.endpoint;

    // Build fallback model configurations (tried in order if primary times out or errors)
    type FallbackConfig = { model: string; providerId: string | null; label: string };
    const fallbackConfigs: FallbackConfig[] = [];

    // When a task override is active (heartbeat/cron using a different model than the
    // Choom's primary), prepend the primary model as fallback #0. This way if the
    // heartbeat model fails, we try the Choom's trusted primary before burning through
    // the configured fallback chain (which might be the same model that just failed).
    const taskOverrideActive = !!(taskModelOverride?.model) &&
      llmSettings.model !== preOverrideModel;
    if (taskOverrideActive && preOverrideModel) {
      const preProvider = preOverrideProviderId !== 'local'
        ? providers.find((p: LLMProviderConfig) => p.id === preOverrideProviderId) : null;
      const preLabel = preProvider ? `${preProvider.name}/${preOverrideModel}` : `local/${preOverrideModel}`;
      fallbackConfigs.push({
        model: preOverrideModel,
        providerId: preOverrideProviderId !== 'local' ? preOverrideProviderId : null,
        label: `${preLabel} (primary)`,
      });
      console.log(`   🔄 Task override active — prepended primary model as fallback #0: ${preLabel}`);
    }

    const fbEntries = [
      { model: choom.llmFallbackModel1, providerId: choom.llmFallbackProvider1 },
      { model: choom.llmFallbackModel2, providerId: choom.llmFallbackProvider2 },
    ];
    for (const fb of fbEntries) {
      if (!fb.model && !fb.providerId) continue; // Not configured
      const provider = fb.providerId ? providers.find((p: LLMProviderConfig) => p.id === fb.providerId) : null;
      const model = fb.model || provider?.models?.[0] || llmSettings.model;
      const label = provider ? `${provider.name}/${model}` : `local/${model}`;
      // Skip fallback entries that duplicate the currently-active model+provider
      // (e.g., heartbeat uses Gemma and fallback #1 is also Gemma on same endpoint)
      const activeModel = llmSettings.model;
      const activeEndpoint = llmSettings.endpoint;
      const fbEndpoint = provider?.endpoint || localLMStudioEndpoint;
      if (model === activeModel && fbEndpoint === activeEndpoint) {
        console.log(`   ⏭️  Skipping fallback ${label} — same model+endpoint as active`);
        continue;
      }
      fallbackConfigs.push({ model, providerId: fb.providerId || null, label });
    }
    if (fallbackConfigs.length > 0) {
      console.log(`   🔄 Fallback models: ${fallbackConfigs.map((f, i) => `#${i + 1} ${f.label}`).join(', ')}`);
    }

    // Helper to create an LLM client from a fallback config
    async function createClientForFallback(fb: FallbackConfig): Promise<{ client: { streamChat: LLMClient['streamChat'] }; settings: LLMSettings }> {
      const fbSettings: LLMSettings = { ...llmSettings, model: fb.model };

      // Clear enableThinking inherited from the primary model — it causes
      // chat_template_kwargs to be sent to backends that don't support it
      // (e.g., LM Studio's Qwen template breaks tool calling with this flag).
      // Only re-add if the fallback's own profile explicitly sets it.
      (fbSettings as any).enableThinking = undefined;

      // Apply the fallback model's profile (temperature, topP, etc.) instead of
      // inheriting the primary model's tuning which may be wrong for this model.
      const userProfiles = (settings?.modelProfiles as LLMModelProfile[]) || [];
      const fbProfile = findLLMProfile(fb.model, userProfiles);
      if (fbProfile) {
        if (fbProfile.temperature !== undefined) fbSettings.temperature = fbProfile.temperature;
        if (fbProfile.topP !== undefined) fbSettings.topP = fbProfile.topP;
        if (fbProfile.maxTokens !== undefined) fbSettings.maxTokens = fbProfile.maxTokens;
        if (fbProfile.topK !== undefined) fbSettings.topK = fbProfile.topK;
        if (fbProfile.frequencyPenalty !== undefined) fbSettings.frequencyPenalty = fbProfile.frequencyPenalty;
        if (fbProfile.presencePenalty !== undefined) fbSettings.presencePenalty = fbProfile.presencePenalty;
        if (fbProfile.repetitionPenalty !== undefined) fbSettings.repetitionPenalty = fbProfile.repetitionPenalty;
        if (fbProfile.enableThinking !== undefined) fbSettings.enableThinking = fbProfile.enableThinking;
        console.log(`   📋 Applied profile for fallback model ${fb.model}`);
      } else {
        // No profile found — reset sampling params to safe defaults so the
        // fallback doesn't inherit the primary model's potentially aggressive tuning
        fbSettings.presencePenalty = 0;
        fbSettings.frequencyPenalty = 0;
      }

      if (fb.providerId) {
        const provider = providers.find((p: LLMProviderConfig) => p.id === fb.providerId);
        if (provider) {
          fbSettings.endpoint = provider.endpoint;
          if (provider.type === 'anthropic') {
            // Reset sampling params to Anthropic defaults — don't inherit
            // the primary local model's topP/topK which cause API errors
            fbSettings.temperature = 0.7;
            delete (fbSettings as any).topP;
            delete (fbSettings as any).topK;
            delete (fbSettings as any).repetitionPenalty;
            const { AnthropicClient } = await import('@/lib/anthropic-client');
            return { client: new AnthropicClient(fbSettings, provider.apiKey || '', provider.endpoint), settings: fbSettings };
          }
          return { client: new LLMClient(fbSettings, provider.apiKey || undefined), settings: fbSettings };
        }
      }
      // Local model fallback — use the pre-provider local endpoint (LM Studio),
      // NOT llmSettings.endpoint which may point to NVIDIA/Anthropic after provider assignment
      fbSettings.endpoint = localLMStudioEndpoint;
      console.log(`   🔧 Local fallback: endpoint=${localLMStudioEndpoint}, model=${fb.model}`);
      return { client: new LLMClient(fbSettings), settings: fbSettings };
    }

    // Add current user message
    currentMessages.push({ role: 'user', content: enrichedMessage });

    // Log history sent to LLM for debugging conversation continuity
    const histMsgs = currentMessages.filter(m => m.role !== 'system');
    console.log(`   📜 History for "${choom.name}": ${histMsgs.length} messages (${compactionWasPerformed ? `compacted, ${compactionStats.messagesDropped} dropped` : 'uncompacted'})`);
    for (let i = 0; i < histMsgs.length; i++) {
      const m = histMsgs[i];
      console.log(`      [${i}] ${m.role}: ${(m.content || '').slice(0, 120)}${(m.content || '').length > 120 ? '...' : ''} (${(m.content || '').length} chars)`);
    }

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
        let fallbackAttempt = 0; // Tracks which fallback to try next (0 = try #1, 1 = try #2)

        // Apply per-Choom iteration limit (from <!-- max_iterations: N --> in system prompt)
        if (choomMaxIterations > 0) {
          maxIterations = choomMaxIterations;
          console.log(`   🔒 [${choom.name}] maxIterations → ${maxIterations} (from system prompt directive)`);
        }

        // Request-level override (e.g., scheduler goal_review sends maxIterationsOverride=100)
        // Takes priority over system prompt directive but NOT over delegation cap
        if (maxIterationsOverride && typeof maxIterationsOverride === 'number' && maxIterationsOverride > 0) {
          maxIterations = maxIterationsOverride;
          console.log(`   🔒 [${choom.name}] maxIterations → ${maxIterations} (from request override)`);
        }

        // Apply per-project iteration limit from pre-detected project (detected above from message or chat history)
        // Only apply if neither the Choom directive nor a request override already set a HIGHER limit
        if (detectedProject?.metadata?.maxIterations && detectedProject.metadata.maxIterations > 0) {
          if (maxIterations > detectedProject.metadata.maxIterations) {
            console.log(`   📂 Project "${detectedProject.folder}": maxIterations ${detectedProject.metadata.maxIterations} skipped (current limit is higher: ${maxIterations})`);
          } else {
            maxIterations = detectedProject.metadata.maxIterations;
            projectIterationLimitApplied = true;
            console.log(`   📂 Project "${detectedProject.folder}": maxIterations → ${maxIterations}`);
          }
        }

        // Delegation mode: use the Choom's own directive as the cap (or global default).
        // Don't override lower — the system prompt directive IS the intended limit.
        if (isDelegation) {
          projectIterationLimitApplied = true; // Prevent mid-loop project detection from overriding
          console.log(`   🔒 [${choom.name}] Delegation mode: maxIterations = ${maxIterations}`);
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
          suppressNotifications: !!suppressNotifications,
          isHeartbeat: !!isHeartbeat,
          activeProjectFolder: detectedProject?.folder,
        };

        try {
          const requestStartTime = Date.now();
          let resolvedProvider = activeProviderId;
          const traceBuilder = new TraceBuilder({
            chatId,
            choomId,
            choomName: choom.name as string,
            model: llmSettings.model,
            provider: resolvedProvider,
            endpoint: llmSettings.endpoint || '',
            isDelegation: !!isDelegation,
            isHeartbeat: !!isHeartbeat,
            maxIterations,
          });
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

          // Resolve optional planner model — a fast local model for plan creation (JSON generation).
          // Falls back to primary LLM if not configured or on error.
          let plannerClient: { streamChat: LLMClient['streamChat'] } | null = null;
          const plannerModel = llmSettings.plannerModel;
          if (plannerModel) {
            try {
              const plannerFb: FallbackConfig = {
                model: plannerModel,
                providerId: llmSettings.plannerProviderId || null,
                label: 'planner',
              };
              const { client: pClient } = await createClientForFallback(plannerFb);
              // Override endpoint if explicitly set (e.g. different LM Studio instance)
              if (llmSettings.plannerEndpoint) {
                const plannerSettings: LLMSettings = { ...llmSettings, model: plannerModel, endpoint: llmSettings.plannerEndpoint };
                plannerClient = new LLMClient(plannerSettings);
              } else {
                plannerClient = pClient;
              }
              console.log(`   📋 Planner model: ${plannerModel}${llmSettings.plannerProviderId ? ` (provider: ${llmSettings.plannerProviderId})` : ' (local)'}`);
            } catch (err) {
              console.warn(`   ⚠️  Failed to create planner client, using primary model:`, err instanceof Error ? err.message : err);
            }
          }

          let imageGenCount = 0; // Per-batch image gen counter (cap at 5 per batch; resets each agentic loop iteration)
          let planExecuted = false;
          let planFullySucceeded = false;
          let planHadDelegations = false;
          if (skillDispatch && !isDelegation && isMultiStepRequest(message)) {
            traceBuilder.setPlanMode();
            try {
              console.log(`   📋 Multi-step request detected — creating plan...`);
              const registry = getSkillRegistry();
              const plan = await createPlan(currentMessages, registry, plannerClient || llmClient, activeTools);

              if (plan) {
                console.log(`   📋 Plan created: "${plan.goal}" (${plan.steps.length} steps)`);
                const watcher = new WatcherLoop();

                // Execute plan with progress streaming
                const planToolExecutor = async (toolCall: ToolCall, _iter: number): Promise<ToolResult> => {
                  // Enforce per-batch image gen cap in plan mode (max 5 per plan batch)
                  if (toolCall.name === 'generate_image' && imageGenCount >= 5) {
                    const capped: ToolResult = {
                      toolCallId: toolCall.id, name: toolCall.name, result: null,
                      error: `Image generation limit reached (${imageGenCount}/5 this batch). Skip this step.`,
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
                planHadDelegations = plan.steps.some((s: { type?: string }) => s.type === 'delegate');

                // Inject plan summary into conversation context so the LLM can reference it
                const planSummaryText = summarizePlan(plan);
                const stepSummaries = plan.steps.map(s => {
                  let line = `- ${s.description}: ${s.status}`;
                  if (s.result?.error) line += ` (error: ${s.result.error})`;
                  // For delegation steps, include the actual response so the LLM
                  // doesn't need to call get_delegation_result separately
                  if (s.type === 'delegate' && s.result?.result && typeof s.result.result === 'object') {
                    const delegResult = s.result.result as Record<string, unknown>;
                    const response = delegResult.response as string | undefined;
                    if (response && response.length > 0) {
                      const truncated = response.length > 1500 ? response.slice(0, 1500) + '...[truncated]' : response;
                      line += `\n  Response from ${delegResult.choom_name || s.choomName || 'delegate'}:\n  ${truncated}`;
                    }
                  }
                  return line;
                }).join('\n');

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
          let nudgeCount = 0; // Track how many times we've nudged (max 5)
          // Token usage accumulator — captures usage from each LLM call across iterations
          let totalPromptTokens = 0;
          let totalCompletionTokens = 0;

          // Proactive tool_choice='required': if the user message has strong tool intent,
          // force the LLM to call a tool on the first iteration instead of narrating.
          // This is the biggest reliability win for local models that tend to describe actions.
          const msgLower = message.toLowerCase();
          const strongToolIntent = /\b(what(?:'?s| is) the weather|weather (?:like|today|tomorrow|forecast)|search (?:for|the web)|look up|find (?:me|out)|generate (?:an? |some )?(?:image|picture|photo|selfie|portrait)|take a (?:selfie|photo|picture)|create (?:a |an )?(?:image|picture)|make (?:me |an? )?(?:image|picture|selfie)|(?:please |can you |you should )remember (?:that|this|my|i |the |for )|(?<!i )(?<!i'll )remember (?:that |this |my |i |the |for )|(?:don'?t |never )forget (?:that|this|my|i )|(?:save|store|note|keep) (?:this|that|my|the |it )(?:in |to |as )?(?:memory|mind)?|use (?:the )?remember(?: tool)?|remind me|set (?:a )?reminder|send (?:a )?(?:notification|message|alert)|check (?:the |my )?(?:calendar|schedule|tasks|email|inbox)|(?:any |do i have (?:any )?|what )(?:appointments?|meetings?|events?)|(?:am i |are we )(?:free|busy|available)|what(?:'?s| is) on (?:my )?(?:calendar|schedule|for )?(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this week|next week)|(?:what(?:'?s| is| do i have) )(?:scheduled|planned|coming up)|when (?:is|was|did) (?:my |the )?(?:next|last) |when (?:is|was) the last time i |when did i (?:last )?(?:go|get|have|see|do|visit|fill|take)|write (?:a |an )?(?:file|document|report)|read (?:the |my |this )?(?:file|document|pdf|report)|(?:look|take a look|glance) at (?:the |this |that )?(?:file|document|pdf|report)|open (?:the |this |that )?(?:pdf|report|document)|review (?:the |this |that )?(?:file|document|pdf|report)|list (?:my |the )?(?:files|projects|tasks)|download|scrape|analyze (?:this|the|that) (?:image|photo|picture)|turn (?:on|off) (?:the )?|(?:open|close) (?:the )?|(?:lights?|switch|fan|heater|thermostat) (?:on|off)|delegate|get (?:the )?(?:weather|forecast)|search (?:youtube|email|gmail|contacts)|draft (?:an? )?email|compose (?:an? )?email|^habit\b|habit (?:stats|summary|report|breakdown)|how (?:often|many times) (?:do|did|have) i )\b/i.test(msgLower);
          let forceToolCall = strongToolIntent; // Force tool_choice:'required' on first iteration if intent is strong
          const executedToolCache = new Map<string, unknown>(); // Dedup: normalizedKey → result
          const failedCallCache = new Map<string, string>(); // Cache: dedupKey → error message
          const toolCallCounts = new Map<string, number>(); // Per-tool name call counter
          const brokenTools = new Set<string>(); // Tool names blocked due to config/auth errors
          const toolFailureCounts = new Map<string, number>(); // Per-tool name failure counter
          let consecutiveFailures = 0; // Abort after MAX_CONSECUTIVE_FAILURES
          const MAX_CONSECUTIVE_FAILURES = 6;
          const MAX_CALLS_PER_TOOL = 50; // Max times any single tool can be called per request
          const MAX_CALLS_PER_READONLY_TOOL = 50; // Higher limit for read-only (PARALLEL_SAFE) tools
          const MAX_FAILURES_PER_TOOL = 2; // Block tool after this many failures (any error)
          const choomTag = `[${choom.name}]`;
          console.log(`   🛠️  ${choomTag} Tools available: ${activeTools.length}${skillDispatch ? ' [skill dispatch]' : ''}`);
          // Intent-specific tool guidance: when we detect a specific intent, inject a
          // system message steering the LLM to the correct tool. This prevents the LLM
          // from calling get_calendar_events when the user says "remind me" etc.
          let intentToolHint = '';
          if (/\b(?:remind me|set (?:a )?reminder)\b/i.test(msgLower)) {
            intentToolHint = 'create_reminder';
          } else if (/\b(?:check (?:the |my )?(?:calendar|schedule)|what(?:'?s| is) on (?:my )?(?:calendar|schedule|for )?(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this week|next week)?|(?:any |do i have (?:any )?|what )(?:appointments?|meetings?|events?)|(?:am i |are we )(?:free|busy|available)|(?:what(?:'?s| is| do i have) )(?:scheduled|planned|coming up)|(?:anything )(?:on |scheduled )(?:for )?(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this week|next week)|when (?:is|was|did) (?:my |the )?(?:next|last) |when (?:is|was) the last time i |when did i (?:last )?(?:go|get|have|see|do|visit|fill|take))\b/i.test(msgLower)) {
            intentToolHint = 'get_calendar_events';
          } else if (/^habit\b/i.test(msgLower)) {
            intentToolHint = 'log_habit';
          } else if (/\b(?:habit (?:stats|summary|report|breakdown)|how (?:often|many times) (?:do|did|have) i )\b/i.test(msgLower)) {
            intentToolHint = 'habit_stats';
          }
          if (strongToolIntent) {
            traceBuilder.setForceToolCall();
            console.log(`   ⚡ ${choomTag} Strong tool intent detected — using tool_choice='required' on first iteration${intentToolHint ? ` (hint: ${intentToolHint})` : ''}`);
          }
          if (intentToolHint) {
            currentMessages.push({
              role: 'system',
              content: `[Tool guidance] The user's request maps to the "${intentToolHint}" tool. Call that tool directly — do NOT use other tools for this request.`,
            });
          }

          // Simple tasks model routing: if the user's intent maps to a routine tool
          // and a lightweight model is configured, switch to it. This avoids burning
          // expensive/slow models on simple operations like reminders, habits, weather.
          const SIMPLE_TASK_TOOLS = new Set([
            'create_reminder', 'get_reminders',
            'log_habit', 'habit_stats', 'query_habits',
            'get_calendar_events', 'create_calendar_event', 'update_calendar_event', 'delete_calendar_event',
            'get_weather', 'get_weather_forecast',
            'get_task_list', 'list_task_lists', 'add_to_task_list', 'remove_from_task_list',
            'remember', 'search_memories', 'get_recent_memories',
            'send_notification',
          ]);
          const simpleTasksEnabled = (clientLLMSettings as Record<string, unknown>)?.simpleTasksEnabled;
          const simpleTasksModel = (clientLLMSettings as Record<string, unknown>)?.simpleTasksModel as string | undefined;
          if (simpleTasksEnabled && simpleTasksModel && intentToolHint && SIMPLE_TASK_TOOLS.has(intentToolHint) && !body.taskModelOverride) {
            const simpleProviderId = (clientLLMSettings as Record<string, unknown>)?.simpleTasksProviderId as string | undefined;
            if (simpleProviderId && simpleProviderId !== '_local' && providers.length > 0) {
              const simpleProvider = providers.find((p: LLMProviderConfig) => p.id === simpleProviderId);
              if (simpleProvider) {
                const simpleSettings: LLMSettings = { ...llmSettings, model: simpleTasksModel, endpoint: simpleProvider.endpoint };
                if (simpleProvider.type === 'anthropic') {
                  const { AnthropicClient } = await import('@/lib/anthropic-client');
                  llmClient = new AnthropicClient(simpleSettings, simpleProvider.apiKey || '', simpleProvider.endpoint);
                } else {
                  llmClient = new LLMClient(simpleSettings, simpleProvider.apiKey || undefined);
                }
                llmSettings.model = simpleTasksModel;
                llmSettings.endpoint = simpleProvider.endpoint;
                usingCloudProvider = !isLocalEndpoint(simpleProvider.endpoint);
                resolvedProvider = simpleProvider.id;
                console.log(`   🔀 ${choomTag} Simple task routing: ${simpleProvider.name}/${simpleTasksModel} (intent: ${intentToolHint})`);
              }
            } else {
              llmSettings.model = simpleTasksModel;
              llmSettings.endpoint = defaultLLMSettings.endpoint;
              llmClient = new LLMClient(llmSettings);
              usingCloudProvider = false;
              resolvedProvider = 'local';
              console.log(`   🔀 ${choomTag} Simple task routing: local/${simpleTasksModel} (intent: ${intentToolHint})`);
            }
          }

          // If plan fully succeeded, allow some follow-up iterations for summary, cleanup,
          // and handling incomplete delegations. Don't cap too aggressively — delegation
          // results are often partial and the orchestrator needs room to continue work.
          // Never override a per-project or request-level maxIterations setting.
          if (planFullySucceeded && !projectIterationLimitApplied && !maxIterationsOverride) {
            const postPlanCap = 15;
            maxIterations = Math.min(maxIterations, postPlanCap);
            console.log(`   📋 Post-plan iteration cap: ${maxIterations}`);
          }

          // Preserve any pre-loop content (e.g., plan summaries) so the final iteration can prefix it
          const preLoopContent = fullContent;
          const iterationTexts: string[] = []; // Track each iteration's text for dedup
          let fallbackActivated = false; // Set when a fallback model takes over mid-request
          let retriedCurrentFallback = false; // Guard: only retry a timed-out fallback once

          while (iteration < maxIterations) {
            iteration++;

            // Reset per-batch image gen counter each iteration — the cap is "5 per batch",
            // not "5 per request". A Choom can generate 5 images, save them, do other work,
            // and then generate 5 more in a later iteration as needed.
            imageGenCount = 0;

            // Early exit: if the SSE stream was closed (e.g., delegation aborted by
            // orchestrator, or client disconnected), stop processing immediately.
            if (streamClosed) {
              console.log(`   🛑 ${choomTag} Stream closed (client disconnected) — stopping agentic loop at iteration ${iteration}`);
              break;
            }

            if (iteration > 1) {
              send({ type: 'agent_iteration', iteration, maxIterations });
              console.log(`   🔄 ${choomTag} Agent iteration ${iteration}/${maxIterations}`);

              // Aggressive within-turn compaction: after iteration 3, replace intermediate
              // messages with a compact progress summary. Reduces context from O(iterations)
              // to a fixed ~5 messages. Benefits both regular chats and delegated workers
              // (workers especially — they do many tool iterations and timeout if context grows too large).
              const AGGRESSIVE_COMPACTION_THRESHOLD = 3;
              {
                // Pass the actual context budget so compaction only fires when needed
                const budget = compactionService.calculateBudget(systemPromptWithSummary, activeTools);
                const aggressiveResult = compactionService.compactAggressiveWithinTurn(
                  currentMessages, iteration, AGGRESSIVE_COMPACTION_THRESHOLD, budget.availableForMessages
                );
                if (aggressiveResult.tokensRecovered > 0) {
                  traceBuilder.recordCompaction();
                  const beforeCount = currentMessages.length;
                  currentMessages.length = 0;
                  currentMessages.push(...aggressiveResult.messages);
                  console.log(`   ⚡ ${choomTag} Aggressive compaction: ${beforeCount} → ${currentMessages.length} msgs, recovered ~${aggressiveResult.tokensRecovered.toLocaleString()} tokens`);
                }
              }

              // Within-turn compaction: ensure context fits budget BEFORE calling LLM.
              // Critical tools (workspace_read_file etc.) are exempt from stubbing —
              // the model needs their results to complete multi-step tasks.
              // This runs AFTER aggressive compaction as a second safety net.
              const CRITICAL_TOOLS = new Set(['workspace_read_file', 'workspace_read_pdf', 'workspace_list_files']);
              const withinTurnResult = compactionService.compactWithinTurn(currentMessages, systemPromptWithSummary, activeTools, 2, CRITICAL_TOOLS);
              if (withinTurnResult.truncatedCount > 0) {
                const beforeTokens = Math.ceil(currentMessages.map(m => m.content || '').join('').length / 4);
                currentMessages.length = 0;
                currentMessages.push(...withinTurnResult.messages);
                const afterTokens = Math.ceil(currentMessages.map(m => m.content || '').join('').length / 4);
                const budget = compactionService.calculateBudget(systemPromptWithSummary, activeTools);
                console.log(`   🗜️  Pre-LLM compaction: truncated ${withinTurnResult.truncatedCount} tool results, recovered ~${withinTurnResult.tokensRecovered.toLocaleString()} tokens (~${beforeTokens.toLocaleString()} → ~${afterTokens.toLocaleString()}, budget: ~${budget.availableForMessages.toLocaleString()})`);
              }
            }

            // Stream LLM response
            let iterationContent = '';
            let toolCallsAccumulator = new Map<
              number,
              { id: string; name: string; arguments: string }
            >();
            let finishReason = 'stop';

            // Three-tier timeout system based on endpoint type:
            //
            // LOCAL (LM Studio, Ollama on LAN):
            //   First-token: generous (large models need extended prefill on consumer GPUs)
            //   Between-token: generous (can pause during complex tool-call generation)
            //
            // CLOUD-INFERENCE (NVIDIA NIM, Together, Fireworks, etc.):
            //   First-token: generous (these queue requests, prefill can take 60-120s)
            //   Between-token: tight (once streaming starts, throughput is consistent)
            //
            // CLOUD-FAST (OpenAI, Anthropic):
            //   First-token: tight (fast infrastructure, should start quickly)
            //   Between-token: tight (consistent throughput)
            //
            const isLocal = !usingCloudProvider || isLocalEndpoint(llmSettings.endpoint);
            const endpointLower = (llmSettings.endpoint || '').toLowerCase();
            const isCloudInference = !isLocal && /nvidia|\.nvcf\.|together|fireworks|groq|replicate|deepinfra/.test(endpointLower);
            // isCloudFast = !isLocal && !isCloudInference (OpenAI, Anthropic, etc.)
            const DEFAULT_TIMEOUT_MS = isDelegation ? 300000 : 180000;
            const timeoutMs = (choom.llmTimeoutSec ? choom.llmTimeoutSec * 1000 : DEFAULT_TIMEOUT_MS);

            let FIRST_TOKEN_MS: number;
            let BETWEEN_TOKEN_MS: number;
            if (isLocal) {
              FIRST_TOKEN_MS = Math.max(120000, timeoutMs - 15000);
              BETWEEN_TOKEN_MS = Math.max(120000, Math.floor(timeoutMs * 0.75));
            } else if (isCloudInference) {
              // Generous first-token for queuing, tight between-token
              FIRST_TOKEN_MS = Math.max(120000, timeoutMs - 15000);
              BETWEEN_TOKEN_MS = 45000;
            } else {
              // Cloud-fast: tight everything
              FIRST_TOKEN_MS = 30000;
              BETWEEN_TOKEN_MS = 30000;
            }
            let firstTokenReceived = false;
            let lastChunkTime = Date.now();
            let chunkCount = 0;
            let inactivityTimer: ReturnType<typeof setTimeout> = undefined!;
            let rejectInactivity: (err: Error) => void;
            const inactivityPromise = new Promise<never>((_, reject) => {
              rejectInactivity = reject;
              // Start with first-token timeout (covers prefill phase)
              inactivityTimer = setTimeout(() => reject(new Error(`LLM response timeout (no first token for ${FIRST_TOKEN_MS / 1000}s)`)), FIRST_TOKEN_MS);
            });
            inactivityPromise.catch(() => {}); // suppress unhandled rejection after race
            const resetInactivity = (hasContent: boolean = false) => {
              clearTimeout(inactivityTimer);
              lastChunkTime = Date.now();
              chunkCount++;
              // Only switch from first-token to between-token mode when actual
              // content (text or tool_calls) arrives — not on empty SSE setup
              // chunks. Otherwise the generous prefill timeout gets replaced
              // too early, causing timeouts on large contexts (~28K+ tokens)
              // where prefill legitimately takes 60-120s.
              if (!firstTokenReceived && hasContent) {
                firstTokenReceived = true;
                console.log(`   ⚡ ${choomTag} First content token — switching to ${BETWEEN_TOKEN_MS / 1000}s between-token timeout`);
              }
              const currentTimeout = firstTokenReceived ? BETWEEN_TOKEN_MS : FIRST_TOKEN_MS;
              inactivityTimer = setTimeout(() => rejectInactivity(new Error(
                firstTokenReceived
                  ? `LLM response timeout (no data for ${currentTimeout / 1000}s, last chunk ${Math.round((Date.now() - lastChunkTime) / 1000)}s ago, ${chunkCount} chunks received)`
                  : `LLM response timeout (no first token for ${FIRST_TOKEN_MS / 1000}s)`
              )), currentTimeout);
            };
            const wallClockPromise = new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error('LLM response timeout')), timeoutMs);
            });
            wallClockPromise.catch(() => {}); // suppress unhandled rejection after race

            const toolChoiceOverride = forceToolCall ? 'required' as const : undefined;
            const toolChoiceWasRequired = forceToolCall;
            if (forceToolCall) {
              console.log(`   ⚡ Using tool_choice='required' to force tool invocation`);
              forceToolCall = false; // Reset after use
            }

            // Think-block filter: strips <think>...</think> from reasoning models
            const thinkFilter = createThinkFilter();
            // Tool-call XML filter: strips <tool_call>...</tool_call> emitted as text
            // by local models and captures them for parsing into real tool calls
            const toolCallXmlFilter = createToolCallXmlFilter();
            // JSON tool-call filter: strips [{"name":"...","parameters":{...}}] arrays
            // emitted as plain text (common with Qwen/Mistral models)
            const jsonToolCallFilter = createJsonToolCallFilter();
            // Gemma 4 tool-call filter: strips <|tool_call>call:name{args}<tool_call|>
            // blocks emitted as text when Gemma's special tokens aren't tokenized
            const gemmaToolCallFilter = createGemmaToolCallFilter();
            // Hoisted so fallback loop can also contribute captured blocks
            let capturedXmlToolCalls: string[] = [];
            let capturedFbJsonToolCalls: { id: string; name: string; arguments: Record<string, unknown> }[] = [];
            let thinkTokensFiltered = false;

            // Buffer post-tool-call content for dedup before sending.
            // When tools have already been called, the next text iteration is
            // typically a confirmation ("I've set that reminder..."). Models
            // sometimes repeat this across iterations — streaming it live means
            // TTS and Signal get the duplicate before post-loop dedup can catch it.
            const bufferForDedup = allToolCalls.length > 0 && iterationTexts.length > 0;

            const streamPromise = (async () => {
              for await (const chunk of llmClient.streamChat(currentMessages, activeTools, undefined, toolChoiceOverride)) {
                const hasContent = !!(chunk.choices?.[0]?.delta?.content || chunk.choices?.[0]?.delta?.tool_calls);
                resetInactivity(hasContent); // reset timer; only switch mode on actual content
                if (!chunk.choices || !chunk.choices[0]) continue;
                const choice = chunk.choices[0];

                if (choice.delta.content) {
                  let visible = thinkFilter(choice.delta.content);
                  if (visible) {
                    visible = toolCallXmlFilter.filter(visible);
                    if (visible) {
                      visible = jsonToolCallFilter.filter(visible);
                    }
                    if (visible) {
                      visible = gemmaToolCallFilter.filter(visible);
                    }
                    if (visible) {
                      iterationContent += visible;
                      if (!bufferForDedup) {
                        send({ type: 'content', content: visible });
                      }
                    }
                  } else if (choice.delta.content.length > 0) {
                    thinkTokensFiltered = true;
                  }
                }

                if (choice.delta.tool_calls) {
                  accumulateToolCalls(toolCallsAccumulator, choice.delta);
                }

                if (choice.finish_reason) {
                  finishReason = choice.finish_reason;
                }

                // Capture token usage from final chunk (OpenAI sends usage in last chunk,
                // Anthropic adapter attaches it to the finish_reason chunk)
                if (chunk.usage) {
                  totalPromptTokens += chunk.usage.prompt_tokens || 0;
                  totalCompletionTokens += chunk.usage.completion_tokens || 0;
                }
              }
              // Flush any buffered partial tag that was never completed.
              // Guard: if a fallback took over, the primary IIFE may still
              // finish late — don't corrupt iterationContent.
              if (!fallbackActivated) {
                const flushed = toolCallXmlFilter.flush();
                if (flushed) {
                  iterationContent += flushed;
                  if (!bufferForDedup) {
                    send({ type: 'content', content: flushed });
                  }
                }
                const flushedJson = jsonToolCallFilter.flush();
                if (flushedJson) {
                  iterationContent += flushedJson;
                  if (!bufferForDedup) {
                    send({ type: 'content', content: flushedJson });
                  }
                }
                const flushedGemma = gemmaToolCallFilter.flush();
                if (flushedGemma) {
                  iterationContent += flushedGemma;
                  if (!bufferForDedup) {
                    send({ type: 'content', content: flushedGemma });
                  }
                }
              }
              if (thinkTokensFiltered) {
                console.log(`   🧠 ${choomTag} Think tokens filtered from response`);
              }
            })();

            try {
              await Promise.race([streamPromise, inactivityPromise, wallClockPromise]);
              // Stream succeeded — clean up timers to prevent leaks
              clearTimeout(inactivityTimer);
            } catch (timeoutError) {
              const errMsg = timeoutError instanceof Error ? timeoutError.message : String(timeoutError);
              console.warn(`   ⚠️  LLM response error on iteration ${iteration}: ${errMsg}`);

              // Try fallback models on timeout/error. Even if partial content was streamed,
              // a broken response is worse than switching models. Partial text was already
              // sent to the user; we clear iterationContent and retry with the fallback.
              // Clean up primary model's timer to prevent memory leaks
              clearTimeout(inactivityTimer);

              let fallbackSucceeded = false;
              // If the currently-active fallback timed out (not the primary),
              // allow retrying it once — the timeout may be transient (context
              // grew, API queued). Without this, we burn through the chain
              // linearly and exhaust all fallbacks after a single retry per model.
              if (fallbackActivated && fallbackAttempt > 0 && !retriedCurrentFallback) {
                fallbackAttempt = fallbackAttempt - 1; // retry last-successful fallback
                retriedCurrentFallback = true;
              }
              if (fallbackAttempt < fallbackConfigs.length) {
                if (iterationContent) {
                  console.log(`   ⚠️  ${choomTag} Partial content (${iterationContent.length} chars) streamed before error — clearing for fallback attempt`);
                  send({ type: 'retract_partial', length: iterationContent.length });
                }
                // Strip nudge/hint messages injected for the primary model —
                // the fallback model hasn't seen the primary's behavior and these
                // messages ("You described what you would do...") will confuse it.
                const beforeStrip = currentMessages.length;
                for (let i = currentMessages.length - 1; i >= 1; i--) {
                  const m = currentMessages[i];
                  if (m.role === 'user' && m.content?.startsWith('[System] You described what')) {
                    currentMessages.splice(i, 1);
                  } else if (m.role === 'user' && m.content?.startsWith('[System] You indicated you have more')) {
                    currentMessages.splice(i, 1);
                  } else if (m.role === 'system' && m.content?.startsWith('[Tool guidance]')) {
                    currentMessages.splice(i, 1);
                  }
                }
                if (currentMessages.length < beforeStrip) {
                  console.log(`   🧹 ${choomTag} Stripped ${beforeStrip - currentMessages.length} nudge messages before fallback`);
                }
                for (let fbIdx = fallbackAttempt; fbIdx < fallbackConfigs.length; fbIdx++) {
                  const fb = fallbackConfigs[fbIdx];
                  console.log(`   🔄 ${choomTag} Trying fallback #${fbIdx + 1}: ${fb.label}`);
                  traceBuilder.recordFallback(fb.label);
                  // Log fallback switch server-side only — don't send as content
                  // (it was leaking to Signal messages and TTS audio)
                  send({ type: 'status', content: `Switching to ${fb.label}` });

                  let fbInactivityTimer: ReturnType<typeof setTimeout> = undefined!;
                  try {
                    const { client: fbClient, settings: fbSettings } = await createClientForFallback(fb);
                    // Reset iteration state for the fallback attempt
                    iterationContent = '';
                    toolCallsAccumulator = new Map();
                    finishReason = 'stop';

                    // Fallback timeout: same three-tier approach as primary.
                    const fbIsLocal = !fb.providerId || isLocalEndpoint(fbSettings.endpoint);
                    const fbEndpointLower = (fbSettings.endpoint || '').toLowerCase();
                    const fbIsCloudInference = !fbIsLocal && /nvidia|\.nvcf\.|together|fireworks|groq|replicate|deepinfra/.test(fbEndpointLower);
                    const fbTimeoutMs = fbIsLocal ? timeoutMs : Math.max(60000, Math.floor(timeoutMs * 0.75));
                    let fbFirstTokenMs: number;
                    let fbBetweenTokenMs: number;
                    if (fbIsLocal) {
                      fbFirstTokenMs = Math.max(120000, fbTimeoutMs - 15000);
                      fbBetweenTokenMs = Math.max(120000, Math.floor(fbTimeoutMs * 0.75));
                    } else if (fbIsCloudInference) {
                      fbFirstTokenMs = Math.max(120000, fbTimeoutMs - 15000);
                      fbBetweenTokenMs = 45000;
                    } else {
                      fbFirstTokenMs = 30000;
                      fbBetweenTokenMs = 30000;
                    }
                    let fbFirstTokenReceived = false;
                    let fbRejectInactivity: (err: Error) => void;
                    const fbInactivityPromise = new Promise<never>((_, reject) => {
                      fbRejectInactivity = reject;
                      fbInactivityTimer = setTimeout(() => reject(new Error(`LLM response timeout (no first token for ${fbFirstTokenMs / 1000}s)`)), fbFirstTokenMs);
                    });
                    fbInactivityPromise.catch(() => {});
                    const resetFbInactivity = (hasContent: boolean = false) => {
                      clearTimeout(fbInactivityTimer);
                      if (!fbFirstTokenReceived && hasContent) {
                        fbFirstTokenReceived = true;
                        console.log(`   ⚡ ${choomTag} Fallback first content token — switching to ${fbBetweenTokenMs / 1000}s between-token timeout`);
                      }
                      const currentTimeout = fbFirstTokenReceived ? fbBetweenTokenMs : fbFirstTokenMs;
                      fbInactivityTimer = setTimeout(() => fbRejectInactivity(new Error(
                        fbFirstTokenReceived
                          ? `LLM response timeout (no data for ${fbBetweenTokenMs / 1000}s)`
                          : `LLM response timeout (no first token for ${fbFirstTokenMs / 1000}s)`
                      )), currentTimeout);
                    };
                    const fbWallClockPromise = new Promise<never>((_, reject) => {
                      setTimeout(() => reject(new Error('LLM response timeout')), fbTimeoutMs);
                    });
                    fbWallClockPromise.catch(() => {});
                    console.log(`   ⏱️  Fallback timeout: ${fbTimeoutMs / 1000}s wall-clock, ${fbFirstTokenMs / 1000}s first-token, ${fbBetweenTokenMs / 1000}s between-token (primary was ${timeoutMs / 1000}s)`);

                    const fbThinkFilter = createThinkFilter();
                    const fbToolCallXmlFilter = createToolCallXmlFilter();
                    const fbJsonToolCallFilter = createJsonToolCallFilter();
                    const fbStreamPromise = (async () => {
                      for await (const chunk of fbClient.streamChat(currentMessages, activeTools, undefined, toolChoiceOverride)) {
                        const fbHasContent = !!(chunk.choices?.[0]?.delta?.content || chunk.choices?.[0]?.delta?.tool_calls);
                        resetFbInactivity(fbHasContent);
                        if (!chunk.choices || !chunk.choices[0]) continue;
                        const choice = chunk.choices[0];
                        if (choice.delta.content) {
                          let visible = fbThinkFilter(choice.delta.content);
                          if (visible) {
                            visible = fbToolCallXmlFilter.filter(visible);
                            if (visible) {
                              visible = fbJsonToolCallFilter.filter(visible);
                            }
                            if (visible) {
                              iterationContent += visible;
                              if (!bufferForDedup) {
                                send({ type: 'content', content: visible });
                              }
                            }
                          }
                        }
                        if (choice.delta.tool_calls) {
                          accumulateToolCalls(toolCallsAccumulator, choice.delta);
                        }
                        if (choice.finish_reason) {
                          finishReason = choice.finish_reason;
                        }
                        if (chunk.usage) {
                          totalPromptTokens += chunk.usage.prompt_tokens || 0;
                          totalCompletionTokens += chunk.usage.completion_tokens || 0;
                        }
                      }
                      // Flush any buffered partial tag
                      const fbFlushed = fbToolCallXmlFilter.flush();
                      if (fbFlushed) {
                        iterationContent += fbFlushed;
                        if (!bufferForDedup) {
                          send({ type: 'content', content: fbFlushed });
                        }
                      }
                      const fbFlushedJson = fbJsonToolCallFilter.flush();
                      if (fbFlushedJson) {
                        iterationContent += fbFlushedJson;
                        if (!bufferForDedup) {
                          send({ type: 'content', content: fbFlushedJson });
                        }
                      }
                    })();

                    await Promise.race([fbStreamPromise, fbInactivityPromise, fbWallClockPromise]);
                    clearTimeout(fbInactivityTimer); // clean up timer

                    // Fallback succeeded — switch llmClient for rest of this request
                    llmClient = fbClient;
                    llmSettings.model = fbSettings.model;
                    llmSettings.endpoint = fbSettings.endpoint;

                    // Chinese-origin models (DeepSeek, GLM, Baichuan, Qwen) sometimes
                    // respond in Chinese. Inject a language enforcement reminder.
                    const modelLower = (fbSettings.model || '').toLowerCase();
                    if (/deepseek|glm|baichuan|qwen|chatglm/.test(modelLower)) {
                      currentMessages.push({
                        role: 'system',
                        content: '[IMPORTANT] You MUST respond in English only. Do not use Chinese or any other language.',
                      });
                    }
                    fallbackSucceeded = true;
                    fallbackActivated = true;
                    resolvedProvider = fb.providerId || 'local';
                    capturedXmlToolCalls = fbToolCallXmlFilter.getCaptured();
                    capturedFbJsonToolCalls = fbJsonToolCallFilter.getCaptured();
                    fallbackAttempt = fbIdx + 1;
                    // Allow nudge logic on the next iteration even if tools were already called,
                    // since the fallback model hasn't had a chance to call tools yet and may
                    // narrate instead of acting on its first try.
                    nudgeCount = 0;
                    console.log(`   ✅ ${choomTag} Fallback #${fbIdx + 1} succeeded: ${fb.label} (model=${fbSettings.model})`);
                    break;
                  } catch (fbError) {
                    clearTimeout(fbInactivityTimer); // clean up timer
                    const fbErrMsg = fbError instanceof Error ? fbError.message : String(fbError);
                    console.warn(`   ⚠️  ${choomTag} Fallback #${fbIdx + 1} (${fb.label}) also failed: ${fbErrMsg}`);
                    fallbackAttempt = fbIdx + 1;
                    // Clear any partial content from failed fallback
                    iterationContent = '';
                    toolCallsAccumulator = new Map();
                    continue;
                  }
                }
              }

              if (!fallbackSucceeded) {
                const triedFallbacks = fallbackAttempt > 0 ? ` (tried ${fallbackAttempt} fallback${fallbackAttempt > 1 ? 's' : ''})` : '';
                if (!iterationContent && iteration === 1) {
                  iterationContent = `I'm sorry, the response timed out${triedFallbacks}. Please try again.`;
                  send({ type: 'content', content: iterationContent });
                }
                break;
              }
              // If fallback succeeded, continue processing this iteration's results normally
            }

            // Convert accumulated tool calls — parse each individually so one bad call
            // doesn't drop ALL of them. Includes basic JSON repair for common LLM errors.
            let toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[] = [];
            let droppedToolCalls: string[] = []; // track names of dropped calls for retry logic
            let repairedToolCalls = 0;
            if (toolCallsAccumulator.size > 0) {
              for (const tc of toolCallsAccumulator.values()) {
                const callId = tc.id || `fallback_${Date.now()}_${toolCalls.length}`;
                try {
                  const args = JSON.parse(tc.arguments || '{}');
                  toolCalls.push({ id: callId, name: tc.name, arguments: args });
                } catch {
                  // Tier 1: State-machine JSON repair (handles truncated strings, missing braces)
                  const repaired = tryRepairJSON(tc.arguments);
                  if (repaired !== null) {
                    toolCalls.push({ id: callId, name: tc.name, arguments: repaired });
                    repairedToolCalls++;
                    console.warn(`   🔧 Repaired malformed JSON for ${tc.name}`);
                  } else if (tc.name === 'workspace_write_file') {
                    // Tier 2a: Special rescue for write_file (regex-based path+content extraction)
                    const rescued = tryRescueWriteFile(tc.arguments);
                    if (rescued) {
                      toolCalls.push({ id: callId, name: tc.name, arguments: rescued });
                      repairedToolCalls++;
                    } else {
                      droppedToolCalls.push(tc.name);
                      console.warn(`   ⚠️  Dropping tool call ${tc.name} — unrecoverable JSON: ${tc.arguments?.slice(0, 100)}`);
                    }
                  } else {
                    // Tier 2b: Generic content rescue (extracts key-value pairs from broken JSON)
                    const rescued = tryRescueContentTool(tc.arguments);
                    if (rescued) {
                      toolCalls.push({ id: callId, name: tc.name, arguments: rescued });
                      repairedToolCalls++;
                    } else {
                      droppedToolCalls.push(tc.name);
                      console.warn(`   ⚠️  Dropping tool call ${tc.name} — unrecoverable JSON: ${tc.arguments?.slice(0, 100)}`);
                    }
                  }
                }
              }
            }

            // Drop tool calls with empty/invalid names — weak models sometimes emit these,
            // causing 400 errors from the API on the next iteration
            if (toolCalls.length > 0) {
              const validToolCalls = toolCalls.filter(tc => {
                if (!tc.name || !/^[a-zA-Z0-9_-]+$/.test(tc.name)) {
                  console.warn(`   ⚠️  Dropping tool call with invalid name: "${tc.name || '(empty)'}"`);
                  return false;
                }
                return true;
              });
              toolCalls = validToolCalls;
            }

            // Empty-args guard: some models (Gemma 4 26B observed) emit structured
            // tool_calls with an empty arguments string that parses to `{}`. Without
            // this check, the call proceeds into the handler with no params and fails
            // in confusing ways downstream (e.g., generate_image runs with undefined
            // prompt, succeeds in SD, then Prisma fails on the insert with the full
            // base64 imageUrl in the error message).
            //
            // We only drop empty-args calls when the tool's schema declares required
            // params — legitimate no-arg tools (e.g., get_memory_stats) are preserved.
            // Dropped calls are converted into error results so the model sees the
            // failure on the next iteration and retries with the correct arguments.
            if (toolCalls.length > 0) {
              const emptyArgReplacements: ToolResult[] = [];
              const keptCalls: typeof toolCalls = [];
              for (const tc of toolCalls) {
                const hasArgs = tc.arguments && Object.keys(tc.arguments).length > 0;
                if (!hasArgs) {
                  const toolDef = activeTools.find(t => t.name === tc.name);
                  const requiredParams = (toolDef?.parameters as { required?: string[] })?.required;
                  if (requiredParams && requiredParams.length > 0) {
                    const requiredList = requiredParams.join(', ');
                    console.warn(`   ⚠️  ${choomTag} ${tc.name} called with empty arguments but requires [${requiredList}] — converting to error for retry`);
                    emptyArgReplacements.push({
                      toolCallId: tc.id,
                      name: tc.name,
                      result: null,
                      error: `${tc.name} was called without any arguments, but requires: ${requiredList}. Retry the call with all required parameters. Do not call ${tc.name} with an empty args object again — include the required fields explicitly.`,
                    });
                    continue;
                  }
                }
                keptCalls.push(tc);
              }
              toolCalls = keptCalls;
              // Push the synthetic error results so the model sees them on the next iteration
              for (const r of emptyArgReplacements) {
                allToolResults.push(r);
                send({ type: 'tool_call', toolCall: { id: r.toolCallId, name: r.name, arguments: {} } });
                send({ type: 'tool_result', toolResult: r });
                traceBuilder.recordToolCall({
                  id: r.toolCallId,
                  name: r.name,
                  args: {},
                  success: false,
                  error: r.error,
                  errorClass: 'param',
                  iteration,
                  parallel: false,
                  blocked: true,
                });
              }
            }

            // Parse any XML <tool_call> blocks captured during streaming.
            // These are tool calls emitted as text by local models instead of structured calls.
            // Primary filter captures are always available; fallback captures are added
            // to capturedXmlToolCalls when a fallback model succeeds.
            const allCapturedXml = capturedXmlToolCalls.length > 0
              ? capturedXmlToolCalls
              : toolCallXmlFilter.getCaptured();
            if (allCapturedXml.length > 0) {
              const xmlToolCalls = parseXmlToolCalls(allCapturedXml);
              for (const xtc of xmlToolCalls) {
                if (xtc.name && /^[a-zA-Z0-9_-]+$/.test(xtc.name)) {
                  console.log(`   🔧 ${choomTag} Parsed XML <tool_call>: ${xtc.name}(${JSON.stringify(xtc.arguments).slice(0, 80)})`);
                  toolCalls.push(xtc);
                }
              }
            }

            // Parse any JSON [{"name":"...","parameters":{...}}] blocks captured during streaming.
            const capturedJsonTCs = capturedFbJsonToolCalls.length > 0
              ? capturedFbJsonToolCalls
              : jsonToolCallFilter.getCaptured();
            if (capturedJsonTCs.length > 0) {
              for (const jtc of capturedJsonTCs) {
                console.log(`   🔧 ${choomTag} Parsed JSON tool call: ${jtc.name}(${JSON.stringify(jtc.arguments).slice(0, 80)})`);
                toolCalls.push(jtc);
              }
            }

            // Parse any Gemma 4 <|tool_call>call:name{...}<tool_call|> blocks
            // captured during streaming. These look like tool calls the model
            // "already executed" but actually never hit the API layer.
            const capturedGemmaTCs = gemmaToolCallFilter.getCaptured();
            if (capturedGemmaTCs.length > 0) {
              for (const gtc of capturedGemmaTCs) {
                if (gtc.name && /^[a-zA-Z0-9_-]+$/.test(gtc.name)) {
                  console.log(`   🔧 ${choomTag} Parsed Gemma tool call: ${gtc.name}(${JSON.stringify(gtc.arguments).slice(0, 80)})`);
                  toolCalls.push(gtc);
                }
              }
            }

            // ── finish_reason === 'length' recovery ──
            // When the LLM's output was truncated due to max_tokens AND tool calls
            // were dropped or repaired (truncated content), retry with higher max_tokens
            // instead of proceeding with incomplete results.
            if (finishReason === 'length' && (droppedToolCalls.length > 0 || repairedToolCalls > 0)) {
              const currentMax = llmSettings.maxTokens || 4096;
              const bumpedMax = Math.min(currentMax * 2, 16384);
              const hasDropped = droppedToolCalls.length > 0;

              if (currentMax < 16384) {
                console.log(`   ⚠️  ${choomTag} Output truncated (finish_reason=length) — ${hasDropped ? `dropped: [${droppedToolCalls.join(', ')}]` : `${repairedToolCalls} repaired`}. Bumping max_tokens ${currentMax} → ${bumpedMax} and retrying.`);

                // Bump max_tokens for rest of this request
                llmSettings.maxTokens = bumpedMax;
                // Also update the active client's settings (may differ from llmSettings after fallback)
                if ('settings' in llmClient && (llmClient as LLMClient).settings) {
                  (llmClient as LLMClient).settings.maxTokens = bumpedMax;
                }

                // If we had to drop tool calls entirely, discard everything from this
                // iteration and ask the model to retry — partial content was likely just
                // preamble ("Let me create a document...") anyway.
                if (hasDropped) {
                  // Don't execute any tool calls from this truncated response
                  toolCalls = [];
                  currentMessages.push({ role: 'assistant', content: iterationContent || '' });
                  currentMessages.push({
                    role: 'user',
                    content: `[System] Your previous response was truncated because it exceeded the output token limit. The following tool calls had incomplete/unparseable arguments and were dropped: [${droppedToolCalls.join(', ')}]. The output limit has been increased. Please retry your tool call — if the content is very long, consider breaking it into smaller parts or being more concise.`,
                  });
                  console.log(`   🔄 ${choomTag} Retrying iteration after output truncation`);
                  continue;
                }
                // If all calls were repaired (not dropped), proceed — but log the bump
                // so the next iteration benefits from higher limit
              } else {
                console.warn(`   ⚠️  ${choomTag} Output truncated but max_tokens already at ${currentMax} — proceeding with ${hasDropped ? 'dropped' : 'repaired'} tool calls`);
              }
            }

            // Within-content dedup safety net: if the inline detector missed it
            // (e.g., repeat started right at the checkpoint boundary), catch it
            // post-stream using midpoint splitting (same approach as choom_client.py).
            if (iterationContent.length > 100) {
              const trimmed = iterationContent.trim();
              const mid = Math.floor(trimmed.length / 2);
              for (let offset = 0; offset < Math.min(100, mid); offset++) {
                for (const pos of [mid + offset, mid - offset]) {
                  if (pos < 30 || pos >= trimmed.length - 30) continue;
                  const first = trimmed.slice(0, pos).trim();
                  const second = trimmed.slice(pos).trim();
                  if (first === second && first.length > 30) {
                    console.log(`   🔄 ${choomTag} Post-stream dedup: ${trimmed.length} → ${first.length} chars`);
                    iterationContent = first;
                    offset = mid; // break outer
                    break;
                  }
                }
              }
            }

            // Strip tool schema bleed: models sometimes echo tool definitions as text,
            // dumping dozens of {"name":"...","parameters":{...}} objects. These aren't
            // tool calls (they have "parameters" with type schemas, not "arguments" with
            // actual values). Strip them so the user doesn't see schema spam.
            if (iterationContent.includes('"parameters"') && iterationContent.includes('"name"')) {
              const schemaPattern = /\{\s*"name"\s*:\s*"[a-zA-Z_]+"\s*,\s*"parameters"\s*:\s*\{[^}]*\}\s*\}/g;
              const matches = iterationContent.match(schemaPattern);
              if (matches && matches.length >= 3) {
                // 3+ schema blocks = clearly echoing tool definitions, not real content
                const stripped = iterationContent.replace(
                  /,?\s*\{\s*"name"\s*:\s*"[a-zA-Z_]+"\s*,\s*"parameters"\s*:\s*\{[^}]*\}\s*\}/g, ''
                ).trim();
                console.log(`   🧹 ${choomTag} Stripped ${matches.length} tool schema blocks from response (${iterationContent.length} → ${stripped.length} chars)`);
                iterationContent = stripped;
              }
            }

            // Flush or suppress buffered post-tool-call content
            if (bufferForDedup && iterationContent.trim()) {
              const isDuplicate = iterationTexts.some(prev => prev.trim() === iterationContent.trim());
              if (isDuplicate) {
                console.log(`   🔄 ${choomTag} Suppressed duplicate post-tool content (${iterationContent.length} chars)`);
                iterationContent = ''; // Don't track or send
              } else {
                // Content is unique — flush the buffer to client
                send({ type: 'content', content: iterationContent });
              }
            }

            // Track this iteration's text for post-loop dedup & assembly
            if (iterationContent.trim()) {
              iterationTexts.push(iterationContent);
            }

            // Text extraction and nudging: ONLY when no tools have been called yet.
            // Once any tool succeeds, the model's next text response is the final answer.
            // This prevents loops where confirmations ("I've saved that") get misread
            // as new action narration and trigger re-extraction or re-nudging.
            // Extraction also skipped for long responses (800+ chars) which are
            // substantive answers containing incidental action words ("search", "analyze").
            if (toolCalls.length === 0 && allToolCalls.length === 0 && iterationContent.length < 800) {
              const availableToolNames = new Set(activeTools.map(t => t.name));
              const extracted = extractToolCallFromText(iterationContent, message, availableToolNames);
              if (extracted) {
                console.log(`   🧲 ${choomTag} Extracted tool call from text: ${extracted.name}(${JSON.stringify(extracted.arguments).slice(0, 80)})`);
                toolCalls.push(extracted);
              }
            }

            // Still no tool calls after extraction — check if we should nudge or stop
            if (toolCalls.length === 0) {
              // If tools were already called this request, check if model intends more work.
              // Models often narrate their next step ("Now let me update the file...")
              // before the loop breaks — losing the write-back, notification, etc.
              if (allToolCalls.length > 0 && !(fallbackActivated && nudgeCount === 0)) {
                const lc = iterationContent.toLowerCase();

                // Check 1: Model narrates its next step ("now let me update...")
                const planningNext = /(?:now (?:let me|i'?ll|i need to|i should|i'?m going to)|next,? i'?ll|next step|then i'?ll|i(?:'ll| will) (?:also|now|then)|let me (?:also|now|update|write|save|send|notify)|updating|writing the|saving the|appending|i still need to)/i.test(lc);

                // Check 2: Original task mentions steps that were never completed.
                // Compare the user's instructions against tools actually called.
                const calledToolNames = new Set(allToolCalls.map(tc => tc.name));
                const msgLower = message.toLowerCase();
                const unfinishedSteps: string[] = [];
                if (/(?:update|write|append|save|modify).*(?:file|history|prompt|log)/i.test(msgLower) &&
                    !calledToolNames.has('workspace_write_file')) {
                  unfinishedSteps.push('update/write file (workspace_write_file)');
                }
                if (!suppressNotifications &&
                    /(?:send|notify|notification|signal|let me know|tell me)/i.test(msgLower) &&
                    !calledToolNames.has('send_notification')) {
                  unfinishedSteps.push('send notification (send_notification)');
                }
                if (/(?:read|check|open|look at).*(?:file|history|prompt)/i.test(msgLower) &&
                    !calledToolNames.has('workspace_read_file')) {
                  unfinishedSteps.push('read file (workspace_read_file)');
                }

                const hasUnfinished = unfinishedSteps.length > 0;

                if ((planningNext || hasUnfinished) && nudgeCount < 3 && iteration < maxIterations - 1) {
                  nudgeCount++;
                  traceBuilder.recordNudge(hasUnfinished ? 'unfinished_steps' : 'task_continuation');
                  const reason = hasUnfinished
                    ? `unfinished steps: ${unfinishedSteps.join(', ')}`
                    : 'model indicated more steps pending';
                  console.log(`   🔄 ${choomTag} Task continuation nudge ${nudgeCount}/3 — ${reason}`);
                  currentMessages.push({ role: 'assistant', content: iterationContent });
                  const nudgeMsg = hasUnfinished
                    ? `[System] You have NOT completed all steps from the original instructions. Remaining: ${unfinishedSteps.join('; ')}. Call the next tool NOW.`
                    : '[System] You indicated you have more steps to complete. Call the next tool NOW. Do not narrate — make the tool call directly.';
                  currentMessages.push({ role: 'user', content: nudgeMsg });
                  forceToolCall = true;
                  continue;
                }
                break; // fullContent built from iterationTexts after loop
              }

              // tool_choice='required' was sent but model returned text without tool calls.
              // This is a hard failure — always nudge regardless of what the text says.
              // Catches false confirmations like "Logged!" or "Done!" from weak models.
              if (toolChoiceWasRequired && nudgeCount < 2 && activeTools.length > 0) {
                nudgeCount++;
                traceBuilder.recordNudge('forced_tool_choice_ignored');
                const hint = intentToolHint ? ` Use the "${intentToolHint}" tool.` : '';
                console.log(`   🔄 ${choomTag} Nudge ${nudgeCount}/2 — model ignored tool_choice=required, retrying${hint}`);
                currentMessages.push({ role: 'assistant', content: iterationContent });
                currentMessages.push({
                  role: 'user',
                  content: `[System] You responded with text but did NOT make a tool call. You MUST call a tool — do not describe the action or claim it is done.${hint} Make the function call NOW.`,
                });
                forceToolCall = true;
                continue;
              }

              // No tools called yet — check if model is narrating instead of acting
              const lowerContent = iterationContent.toLowerCase();

              const describesToolAction =
                /(?:(?:generat|creat|mak|produc|design|render|draw|craft|captur|snap)\w*\s+(?:\d+\s+)?(?:\w+\s+)?(?:unique\s+|some\s+|a\s+|an\s+|the\s+|your\s+|my\s+)?(?:\w+\s+)?(?:image|selfie|portrait|picture|photo|illustration|artwork))|(?:(?:search|check|fetch|get|grab|download|send|analyz|look\w* up)\w*\s+(?:the |your |a |for )?(?:weather|forecast|web|image|file|email|contact|video|result|drone|review))|(?:(?:here(?:'s| is| are)|i (?:created|generated|made|took|prepared|composed|rendered))\s+(?:the |your |some |a |\d+ )?(?:\w+ )?(?:image|selfie|portrait|picture|photo|illustration|result|file|forecast))|(?:i (?:created|generated|made)\s+\d+\s+\w+)|(?:(?:remember|sav|stor|not|record|keep)\w*\s+(?:that|this|it|your|the )\s*(?:in |to |as )?(?:my |your )?(?:memory|notes|knowledge)?)|(?:(?:i'?ve |i have |i )?(?:stored|saved|noted|recorded|memorized|remembered)\s+(?:that|this|it|your|the ))|(?:(?:fix|updat|edit|modif|correct|rewrit|patch|chang|writ)\w*\s+(?:the |this |that )?(?:file|code|script|bug|issue|error|implementation|model|function|class))|(?:(?:set|creat|schedul)\w*\s+(?:a\s+|the\s+|your\s+)?(?:reminder|remind))|(?:(?:i'?ll |i will |let me )?remind\s+(?:you|the user))|(?:^logged[!.\s]|(?:i'?ve |i )?logged\s+(?:your|that|this|the|it|a ))/i.test(lowerContent);

              // Short preambles (< 500 chars) are likely pure narration.
              // Longer responses may also be narration (planning essays) — detect
              // those by checking if the text ends with an action statement.
              const isShortPreamble = iterationContent.length < 500;
              const endsWithActionIntent = /(?:let me|i'll|i will|then i'll|let's|dive in|here goes|let me start)\s*[!.]*\s*$/i.test(lowerContent.trim());
              const suggestsAction = (isShortPreamble || endsWithActionIntent) &&
                /\b(let me(?! know| share| tell| explain| describe| show you what| be )|i'll (?!be\b)|i will (?!be\b)|i can (?!help|assist)|i'?m going to|here(?:'s| is) (?:a |your |the )|checking|looking up|searching|analyzing|fetching|downloading|setting up|working on|now (?:i'll|let me|i need to)|fixing|updating|writing|correcting|applying)\b/.test(lowerContent);

              const suggestsToolUse = describesToolAction || suggestsAction;
              if (nudgeCount < 2 && suggestsToolUse && activeTools.length > 0) {
                nudgeCount++;
                traceBuilder.recordNudge('tool_use');
                // Build a dynamic tool hint based on what the LLM seems to be describing
                const toolHints: string[] = [];
                if (/(?:image|selfie|portrait|picture|photo|illustration|artwork)/i.test(lowerContent)) {
                  toolHints.push('for images/selfies use generate_image');
                }
                if (/(?:remind|reminder)/i.test(lowerContent)) {
                  toolHints.push('for reminders use create_reminder (NOT get_calendar_events)');
                }
                if (/(?:weather|forecast|temperature)/i.test(lowerContent)) {
                  toolHints.push('for weather use get_weather');
                }
                if (/(?:search|look\w* up|find|query|browse)/i.test(lowerContent)) {
                  toolHints.push('for web search use web_search');
                }
                if (/(?:pdf|\.pdf)/i.test(lowerContent) && /(?:read|open|extract|look|review|access|text from)/i.test(lowerContent)) {
                  toolHints.push('for reading PDFs use workspace_read_pdf');
                } else if (/(?:file|document|write|save to|create a )/i.test(lowerContent) && !/(?:memor|remember|store|note|record)/i.test(lowerContent)) {
                  toolHints.push('for files use workspace_write_file or workspace_read_file');
                }
                if (/(?:remember|save|stor|not[ei]|record|memoriz|keep.*(?:mind|memory))/i.test(lowerContent)) {
                  toolHints.push('for saving memories use remember');
                }
                if (/(?:email|gmail|inbox|message)/i.test(lowerContent)) {
                  toolHints.push('for email use list_emails, read_email, or send_email');
                }
                if (/(?:calendar|check (?:my |the )?schedule|book (?:a |an )?(?:meeting|appointment))/i.test(lowerContent)) {
                  toolHints.push('for calendar use get_calendar_events');
                }
                if (/(?:delegat|ask|forward|pass.*to)/i.test(lowerContent)) {
                  toolHints.push('for delegation use delegate_to_choom');
                }
                if (/(?:turn |switch |lights?|fan|thermostat|heater)/i.test(lowerContent)) {
                  toolHints.push('for smart home use ha_call_service');
                }
                if (/(?:logged|habit|track|soda|water|drank|ate|workout|exercise)/i.test(lowerContent)) {
                  toolHints.push('for habits use log_habit');
                }
                // Fallback if no specific hint matched
                if (toolHints.length === 0) {
                  toolHints.push('check the available tools and call the most appropriate one');
                }
                const hintStr = toolHints.join(', ');
                console.log(`   🔄 ${choomTag} Nudge ${nudgeCount}/2 with tool_choice=required (hints: ${hintStr})`);
                currentMessages.push({ role: 'assistant', content: iterationContent });
                currentMessages.push({
                  role: 'user',
                  content: `[System] You described what you would do but did not call any tools. You MUST use function calls — do NOT describe what you plan to do or narrate the action. Call the tool NOW using the function calling format. Hints: ${hintStr}. Do not reply with text — only make a tool call.`,
                });
                forceToolCall = true;
                continue;
              }
              break; // fullContent built from iterationTexts after loop
            }

            // Iteration has tool calls — text is preamble ("Let me check...").
            // Already tracked in iterationTexts above; fullContent built after loop.

            // Track all tool calls for DB save
            allToolCalls = [...allToolCalls, ...toolCalls];

            // Execute tool calls — parallel for read-only tools, sequential for mutating tools
            const PARALLEL_SAFE = new Set([
              'get_weather', 'get_weather_forecast', 'web_search',
              'search_memories', 'search_by_type', 'search_by_tags', 'get_recent_memories',
              'search_by_date_range', 'get_memory_stats',
              'workspace_read_file', 'workspace_list_files',
              'scrape_page_images',
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

              // --- Image generation cap (per batch) ---
              // Note: the batch-aware check above (imageGenCount + pendingImageGenInBatch)
              // catches this first. This is a safety net for any path that skips that check.
              if (tc.name === 'generate_image' && imageGenCount >= 5) {
                console.log(`   🖼️  Skipping generate_image (${imageGenCount}/5 already generated this batch)`);
                return { toolCallId: tc.id, name: tc.name, result: { success: false, message: `Image generation limit reached (${imageGenCount}/5 this batch). Wait for the next iteration to generate more images.` } };
              }

              // --- Per-tool call counter ---
              const currentToolCount = (toolCallCounts.get(tc.name) || 0) + 1;
              toolCallCounts.set(tc.name, currentToolCount);
              const effectiveLimit = PARALLEL_SAFE.has(tc.name) ? MAX_CALLS_PER_READONLY_TOOL : MAX_CALLS_PER_TOOL;
              if (tc.name !== 'generate_image' && currentToolCount > effectiveLimit) {
                console.log(`   🛑 Tool call limit reached for ${tc.name} (${currentToolCount}/${effectiveLimit})`);
                return { toolCallId: tc.id, name: tc.name, result: { success: false, message: `Tool ${tc.name} has been called ${currentToolCount} times this request (limit: ${effectiveLimit}). You must try a different approach or present your results to the user.` } };
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
            const executeAndProcess = async (tc: { id: string; name: string; arguments: Record<string, unknown> }, isParallel = false): Promise<ToolResult> => {
              send({ type: 'tool_call', toolCall: tc });
              serverLog(choomId, chatId, 'info', 'system', `Tool Call: ${tc.name}`,
                `Arguments: ${JSON.stringify(tc.arguments).slice(0, 200)}`,
                { toolName: tc.name, arguments: tc.arguments });

              traceBuilder.toolCallStart(tc.id);
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

              // Classify error (hoisted for trace logging)
              let errorClass: 'config' | 'param' | 'gpu_busy' | 'no_data' | 'path' | 'other' | undefined;

              // Cache results
              if (!result.error) {
                executedToolCache.set(dedupKey, result.result);
                consecutiveFailures = 0;
              } else {
                console.log(`   ❌ ${choomTag} ${tc.name} failed: ${result.error.slice(0, 200)}`);
                // Classify the error to decide blocking and counting strategy:
                // - Config/auth errors → block immediately (model can't fix these)
                // - Missing param errors → DON'T count toward any failure cap (model can fix by providing params)
                // - Other errors → count toward per-tool cap and consecutive failures
                const isConfigError = /not configured|api key|unauthorized|forbidden|invalid.*(?:model|endpoint|key)|ECONNREFUSED/i.test(result.error);
                const isParamError = /missing required parameter|is required|must provide|please provide/i.test(result.error);
                const isGpuBusy = /GPU is busy|GPU is currently busy/i.test(result.error);
                // "No data/history/results" is informational, not a tool failure — don't count
                const isNoData = /no (?:history |data |results? )(?:data |found )?for /i.test(result.error);
                // File/path not found is recoverable — LLM guessed wrong filename, can list dir and retry
                const isPathError = /ENOENT|no such file or directory|file not found|path not found|does not exist|not found in project/i.test(result.error);
                errorClass = isConfigError ? 'config' : isParamError ? 'param' : isGpuBusy ? 'gpu_busy' : isNoData ? 'no_data' : isPathError ? 'path' : 'other';
                failedCallCache.set(dedupKey, result.error);
                if (isNoData) {
                  // No data found is informational — the tool works, the entity just has no data.
                  // Don't count toward failure caps (prevents blocking ha_get_history etc.)
                  console.log(`   ℹ️  ${tc.name}: no data found (informational, not counted as failure)`);
                } else if (isPathError) {
                  // File/path not found is recoverable — LLM guessed wrong filename.
                  // Don't count toward failure caps. LLM can list the directory and retry
                  // with the correct path. Blocking workspace_read_file after ENOENT
                  // prevents the LLM from reading ANY files for the rest of the request.
                  console.log(`   📁 ${tc.name}: path not found (recoverable, not counted as failure)`);
                } else if (isGpuBusy) {
                  // GPU busy is temporary — don't count as failure, don't block the tool.
                  // The model should stop retrying and inform the user.
                  console.log(`   ⏳ ${tc.name}: GPU busy (temporary, not counted as failure)`);
                } else if (isParamError) {
                  // Param errors are recoverable — don't count toward consecutiveFailures
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

              // Record in execution trace
              traceBuilder.recordToolCall({
                id: tc.id,
                name: tc.name,
                args: tc.arguments,
                success: !result.error,
                error: result.error || undefined,
                errorClass,
                iteration,
                parallel: isParallel,
              });

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
                    if (maxIterations > project.metadata.maxIterations) {
                      projectIterationLimitApplied = true; // Don't check again
                      console.log(`   📂 Project "${topFolder}": maxIterations ${project.metadata.maxIterations} skipped (current limit is higher: ${maxIterations})`);
                    } else {
                      maxIterations = project.metadata.maxIterations;
                      projectIterationLimitApplied = true;
                      console.log(`   📂 Project "${topFolder}": maxIterations overridden to ${maxIterations}`);
                    }
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

            // Phase 0: Dedup identical calls within this iteration + cap batch size.
            // Local models (especially small ones) can go feral and emit 100+ identical
            // calls in a single iteration. Dedup collapses them to one canonical execution;
            // the cap rejects runaway batches with instructive feedback.
            const MAX_PARALLEL_BATCH = 15;
            const dedupMap = new Map<string, string>(); // key → canonical tc.id
            const canonicalResults = new Map<string, ToolResult>(); // canonical tc.id → result
            const duplicateAliases = new Map<string, string>(); // duplicate tc.id → canonical tc.id
            const uniqueCalls: typeof toolCalls = [];
            const cappedResults = new Map<string, ToolResult>(); // tc.id → error result for capped

            for (const tc of toolCalls) {
              const key = `${tc.name}::${JSON.stringify(tc.arguments || {})}`;
              const canonical = dedupMap.get(key);
              if (canonical) {
                duplicateAliases.set(tc.id, canonical);
              } else {
                dedupMap.set(key, tc.id);
                if (uniqueCalls.length >= MAX_PARALLEL_BATCH) {
                  const capped: ToolResult = {
                    toolCallId: tc.id,
                    name: tc.name,
                    result: {
                      success: false,
                      message: `Too many tool calls in one iteration (limit: ${MAX_PARALLEL_BATCH} unique calls). You are likely in a loop — slow down, make fewer focused calls, and check your earlier tool results before calling more.`,
                    },
                    error: `Batch cap exceeded (${MAX_PARALLEL_BATCH})`,
                  };
                  cappedResults.set(tc.id, capped);
                } else {
                  uniqueCalls.push(tc);
                }
              }
            }

            if (duplicateAliases.size > 0 || cappedResults.size > 0) {
              console.log(
                `   🧹 Dedup: ${toolCalls.length} calls → ${uniqueCalls.length} unique` +
                (duplicateAliases.size > 0 ? ` (${duplicateAliases.size} duplicates collapsed)` : '') +
                (cappedResults.size > 0 ? ` | 🚫 ${cappedResults.size} capped` : '')
              );
              for (const capped of cappedResults.values()) {
                allToolResults.push(capped);
                consecutiveFailures++;
                send({ type: 'tool_result', toolResult: capped });
              }
            }

            // Phase 1: Run pre-flight checks on (deduped) tool calls.
            // Track pending image gen calls within this batch to enforce the cap
            // BEFORE execution (otherwise all N calls pass when imageGenCount=0).
            let pendingImageGenInBatch = 0;
            const preFlightResults = new Map<string, ToolResult>(); // tc.id → result
            const pendingCalls: typeof toolCalls = [];
            for (const tc of uniqueCalls) {
              // Batch-aware image gen cap: count calls already queued in this batch.
              // Cap is 5 per batch; imageGenCount resets at the start of each iteration,
              // so later iterations can generate more images if the workflow needs it.
              if (tc.name === 'generate_image' && imageGenCount + pendingImageGenInBatch >= 5) {
                const total = imageGenCount + pendingImageGenInBatch;
                console.log(`   🖼️  Skipping generate_image (${total}/5 already queued this batch)`);
                const skippedImg: ToolResult = { toolCallId: tc.id, name: tc.name, result: { success: false, message: `Image generation limit reached (${total}/5 this batch). You can generate more images in a later iteration if needed.` } };
                preFlightResults.set(tc.id, skippedImg);
                allToolResults.push(skippedImg);
                continue;
              }
              const skipped = preFlightCheck(tc);
              if (skipped) {
                preFlightResults.set(tc.id, skipped);
                allToolResults.push(skipped);
                if (skipped.error) consecutiveFailures++;
                traceBuilder.recordToolCall({
                  id: tc.id, name: tc.name, args: tc.arguments,
                  success: !skipped.error, error: skipped.error || undefined,
                  iteration, parallel: false,
                  cached: !skipped.error, blocked: !!skipped.error,
                });
                send({ type: 'tool_call', toolCall: tc });
                send({ type: 'tool_result', toolResult: skipped });
              } else {
                if (tc.name === 'generate_image') pendingImageGenInBatch++;
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
              const results = await Promise.all(parallelCalls.map(tc => executeAndProcess(tc, true)));
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

            // Merge results in original tool call order (handling dedup aliases + cap)
            for (const tc of toolCalls) {
              let r = cappedResults.get(tc.id)
                || preFlightResults.get(tc.id)
                || parallelResults.get(tc.id)
                || sequentialResults.get(tc.id);
              if (!r) {
                // Duplicate call — alias to canonical's result
                const canonicalId = duplicateAliases.get(tc.id);
                if (canonicalId) {
                  const canonicalResult = preFlightResults.get(canonicalId)
                    || parallelResults.get(canonicalId)
                    || sequentialResults.get(canonicalId);
                  if (canonicalResult) {
                    r = { ...canonicalResult, toolCallId: tc.id };
                    allToolResults.push(r);
                  }
                }
              }
              if (r) iterationResults.push(r);
            }

            // Note: nudgeCount is NOT reset after tool success. Once tools have been
            // called (allToolCalls.length > 0), nudging and extraction are skipped
            // entirely — the model's next text response is accepted as the final answer.

            // If ALL tools in this iteration had REAL failures (not temporary conditions
            // like GPU-busy or no-data), inject an abort hint so the LLM doesn't loop.
            // GPU-busy is transient (another tool is using the GPU) and no-data is
            // informational — neither indicates a broken tool that warrants aborting.
            const TEMPORARY_ERROR = /GPU is busy|GPU is currently busy|no (?:history |data |results? )(?:data |found )?for /i;
            const allFailedThisIteration = iterationResults.length > 0 &&
              iterationResults.every(r => {
                const hasError = r.error || (r.result && typeof r.result === 'object' && (r.result as Record<string, unknown>).success === false);
                if (!hasError) return false; // success — not a failure
                if (r.error && TEMPORARY_ERROR.test(r.error)) return false; // temporary — not a real failure
                return true; // real failure
              });
            if (allFailedThisIteration && failedCallCache.size >= 2) {
              currentMessages.push({
                role: 'user',
                content: '[System] Multiple tool calls have failed. STOP retrying. Tell the user what went wrong and suggest they check their settings. Do NOT call any more tools.',
              });
              // Strip all tools so the LLM physically cannot call them on the next iteration.
              // Previously we only injected a hint but the LLM would ignore it and keep looping.
              activeTools = [];
              console.log(`   🛑 All tools failed this iteration (${failedCallCache.size} total failures) — stripped tools, 1 final iteration to summarize`);
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
              // Strip all tools so the LLM physically cannot call them on the next iteration.
              // Previously we relied on the LLM obeying the hint, but it often ignores it.
              activeTools = [];
              console.log(`   🛑 ${consecutiveFailures} consecutive failures — stripped tools, 1 final iteration to summarize`);
            }

            const approxTokens = Math.ceil(currentMessages.map(m => m.content || '').join('').length / 4);
            console.log(`   🔧 ${choomTag} Next iteration | ${currentMessages.length} msgs | ~${approxTokens.toLocaleString()} tokens`);
          }

          // Assemble fullContent from all iterations, deduplicating repeated text.
          // Streaming already sent each iteration's content to clients in real-time;
          // this ensures the DB-saved version matches (minus exact duplicates where
          // the model repeated itself across iterations).
          if (iterationTexts.length > 0) {
            const seen = new Set<string>();
            const deduped: string[] = [];
            // Walk backwards so the LAST occurrence of duplicated text wins
            for (let i = iterationTexts.length - 1; i >= 0; i--) {
              const normalized = iterationTexts[i].trim();
              if (normalized && !seen.has(normalized)) {
                seen.add(normalized);
                deduped.unshift(iterationTexts[i]);
              }
            }
            const joined = deduped.join('\n\n');
            fullContent = preLoopContent
              ? preLoopContent + '\n\n' + joined
              : joined;
            if (deduped.length < iterationTexts.length) {
              console.log(`   🔄 ${choomTag} Deduped iteration texts: ${iterationTexts.length} → ${deduped.length} unique`);
            }
          }

          // If we hit the max iterations limit, append a progress summary so "continue"
          // messages have context about what was already done (prevents redoing work)
          if (iteration >= maxIterations) {
            // Build progress summary from completed tool calls
            const toolSummaryLines: string[] = [];
            const delegationSummaries: string[] = [];
            const filesWritten: string[] = [];
            const filesRead: string[] = [];
            for (const tc of allToolCalls) {
              if (tc.name === 'delegate_to_choom') {
                const choomName = tc.arguments.choom_name || 'unknown';
                const task = (tc.arguments.task as string || '').slice(0, 100);
                delegationSummaries.push(`- Delegated to ${choomName}: ${task}`);
              } else if (tc.name === 'workspace_write_file') {
                filesWritten.push(tc.arguments.path as string || 'unknown');
              } else if (tc.name === 'workspace_read_file') {
                filesRead.push(tc.arguments.path as string || 'unknown');
              }
            }
            if (delegationSummaries.length > 0) toolSummaryLines.push('**Delegations completed:**\n' + delegationSummaries.join('\n'));
            if (filesWritten.length > 0) toolSummaryLines.push(`**Files written:** ${filesWritten.join(', ')}`);
            if (filesRead.length > 0) toolSummaryLines.push(`**Files read:** ${filesRead.join(', ')}`);

            const otherTools = allToolCalls.filter(tc => !['delegate_to_choom', 'workspace_write_file', 'workspace_read_file', 'workspace_list_files'].includes(tc.name));
            if (otherTools.length > 0) {
              const otherNames = [...new Set(otherTools.map(tc => tc.name))];
              toolSummaryLines.push(`**Other tools used:** ${otherNames.join(', ')}`);
            }

            const progressNote = toolSummaryLines.length > 0
              ? `\n\n[Reached maximum tool iterations — ${allToolCalls.length} tool calls completed]\n\n**Progress so far:**\n${toolSummaryLines.join('\n')}\n\nIf the user says "continue", pick up from where this left off. Do NOT redo completed work.`
              : '\n\n[Reached maximum tool iterations]';

            fullContent += progressNote;
            send({ type: 'content', content: progressNote });
            console.log(`   ⚠️  Hit maxIterations (${maxIterations}${projectIterationLimitApplied ? ' — per-project override' : ''}) — injected progress summary (${allToolCalls.length} tool calls)`);
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
          // Cap serialized sizes to prevent multi-MB rows that crash Prisma Studio / bloat DB
          const MAX_DB_FIELD_CHARS = 100_000;
          let toolCallsJson = allToolCalls.length > 0 ? JSON.stringify(allToolCalls) : null;
          let toolResultsJson = allToolResults.length > 0 ? JSON.stringify(allToolResults) : null;
          // Truncate by dropping trailing array entries to keep valid JSON (not slicing mid-string)
          const truncateJsonArray = (json: string, label: string): string => {
            if (json.length <= MAX_DB_FIELD_CHARS) return json;
            try {
              const arr = JSON.parse(json) as unknown[];
              while (arr.length > 1) {
                arr.pop();
                const attempt = JSON.stringify(arr);
                if (attempt.length <= MAX_DB_FIELD_CHARS) {
                  console.warn(`   ⚠️ ${label} trimmed for DB save: ${arr.length} entries kept (${json.length.toLocaleString()} → ${attempt.length.toLocaleString()} chars)`);
                  return attempt;
                }
              }
              // Even single entry too large — store null
              console.warn(`   ⚠️ ${label} too large even with 1 entry (${json.length.toLocaleString()} chars) — dropping`);
              return '[]';
            } catch {
              return json.slice(0, MAX_DB_FIELD_CHARS); // fallback
            }
          };
          if (toolCallsJson && toolCallsJson.length > MAX_DB_FIELD_CHARS) {
            toolCallsJson = truncateJsonArray(toolCallsJson, 'toolCalls');
          }
          if (toolResultsJson && toolResultsJson.length > MAX_DB_FIELD_CHARS) {
            toolResultsJson = truncateJsonArray(toolResultsJson, 'toolResults');
          }
          await prisma.message.create({
            data: {
              chatId,
              role: 'assistant',
              content: cleanedContent,
              toolCalls: toolCallsJson,
              toolResults: toolResultsJson,
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

          // Record token usage (fire-and-forget — don't block the response)
          // If the provider didn't return usage data, estimate from character counts.
          // Rough approximation: 1 token ≈ 4 characters for English text.
          let finalPromptTokens = totalPromptTokens;
          let finalCompletionTokens = totalCompletionTokens;
          if (totalPromptTokens === 0 && totalCompletionTokens === 0) {
            // Estimate prompt tokens from all messages sent to the LLM
            const promptChars = currentMessages.reduce((sum: number, m: { content?: string }) => sum + (m.content?.length || 0), 0);
            finalPromptTokens = Math.round(promptChars / 4);
            // Estimate completion tokens from generated content + tool call arguments
            const toolArgChars = allToolCalls.reduce((sum: number, tc: { arguments?: Record<string, unknown> }) => {
              try { return sum + JSON.stringify(tc.arguments || {}).length; } catch { return sum; }
            }, 0);
            finalCompletionTokens = Math.round((fullContent.length + toolArgChars) / 4);
          }
          const totalTok = finalPromptTokens + finalCompletionTokens;
          if (totalTok > 0 || iteration > 0) {
            const isEstimated = totalPromptTokens === 0 && totalCompletionTokens === 0;
            prisma.tokenUsage.create({
              data: {
                choomId,
                choomName: (choom.name as string) || 'Unknown',
                chatId,
                model: llmSettings.model,
                provider: resolvedProvider,
                endpoint: llmSettings.endpoint || null,
                promptTokens: finalPromptTokens,
                completionTokens: finalCompletionTokens,
                totalTokens: totalTok,
                iterations: iteration,
                toolCalls: allToolCalls.length,
                toolNames: allToolCalls.length > 0 ? JSON.stringify(allToolCalls.map(t => t.name)) : null,
                durationMs: elapsed,
                source: isDelegation ? 'delegation' : isHeartbeat ? 'heartbeat' : 'chat',
              },
            }).catch(err => console.warn('[TokenUsage] Write failed:', err instanceof Error ? err.message : err));
            if (totalTok > 0) {
              console.log(`   📊 ${choomTag} Tokens: ${finalPromptTokens.toLocaleString()} prompt + ${finalCompletionTokens.toLocaleString()} completion = ${totalTok.toLocaleString()} total${isEstimated ? ' (estimated)' : ''}`);
            }
          }

          // Write execution trace
          const isEstimatedTokens = totalPromptTokens === 0 && totalCompletionTokens === 0;
          traceBuilder.finalize({
            iterations: iteration,
            status: iteration >= maxIterations ? 'max_iterations' : streamClosed ? 'stream_closed' : 'complete',
            durationMs: elapsed,
            promptTokens: finalPromptTokens,
            completionTokens: finalCompletionTokens,
            tokensEstimated: isEstimatedTokens,
            responseLength: fullContent.length,
            brokenTools: [...brokenTools],
          });
          writeTrace(traceBuilder.getTrace());

          send({
            type: 'done',
            content: fullContent,
            resolvedModel: llmSettings.model,
            iteration,
            maxIterations,
            status: iteration >= maxIterations ? 'max_iterations' : 'complete',
          });
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
