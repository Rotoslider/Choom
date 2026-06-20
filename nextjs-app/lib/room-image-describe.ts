import fs from 'fs';
import path from 'path';
import { VisionService } from './vision-service';
import { WORKSPACE_ROOT } from './config';
import type { LLMProviderConfig } from './types';

// Describe images shared in a group room ONCE (server-side, deterministic) so the
// description can be handed to every speaker. Without this, each Choom either has
// to call analyze_image herself (weak models skip it) or — worse — fabricates what
// the image shows. Resolved from bridge-config.json (same source the chat route
// uses) so web + Signal + heartbeat runs all behave the same.

const BRIDGE_CONFIG_PATH = path.join(process.cwd(), 'services', 'signal-bridge', 'bridge-config.json');

// path → description. Module-level so a shared image is analyzed once per process.
const descCache = new Map<string, string>();

function readBridge(): Record<string, unknown> {
  try {
    if (fs.existsSync(BRIDGE_CONFIG_PATH)) return JSON.parse(fs.readFileSync(BRIDGE_CONFIG_PATH, 'utf-8'));
  } catch { /* ignore */ }
  return {};
}

// Mirror (simplified) of the chat route's vision resolution: prefer the configured
// vision provider's endpoint/key, else vision.endpoint, else the llm endpoint;
// model falls back to the llm model (multimodal models do vision natively).
function resolveVisionConfig() {
  const cfg = readBridge();
  const vision = (cfg.vision || {}) as Record<string, unknown>;
  const llm = (cfg.llm || {}) as Record<string, unknown>;
  const providers = (cfg.providers || []) as LLMProviderConfig[];
  let endpoint = (vision.endpoint as string) || (llm.endpoint as string) || 'http://localhost:1234';
  let apiKey: string | undefined;
  const providerId = vision.visionProviderId as string | undefined;
  if (providerId) {
    const p = providers.find(pr => pr.id === providerId);
    if (p?.endpoint) endpoint = p.endpoint.replace(/\/v1\/?$/, ''); // VisionService re-adds /v1
    if (p?.apiKey) apiKey = p.apiKey;
  }
  const rawModel = vision.model as string;
  const model = (rawModel && rawModel !== 'vision-model') ? rawModel : ((llm.model as string) || 'local-model');
  return {
    endpoint,
    model,
    maxTokens: typeof vision.maxTokens === 'number' ? (vision.maxTokens as number) : 1024,
    temperature: typeof vision.temperature === 'number' ? (vision.temperature as number) : 0.3,
    apiKey,
  };
}

const DESCRIBE_PROMPT =
  'Describe this image in 1-2 concise sentences: the main subject, the setting, and any notable detail. Plain description only — no preamble.';

// Short description of a room-shared image, analyzed once (cached). null on any
// failure so the caller can silently skip (never breaks a turn).
export async function describeRoomImage(imagePath: string): Promise<string | null> {
  if (!imagePath) return null;
  const cached = descCache.get(imagePath);
  if (cached !== undefined) return cached;
  try {
    const svc = new VisionService(resolveVisionConfig());
    const res = await svc.analyzeImage({ prompt: DESCRIBE_PROMPT, imagePath }, WORKSPACE_ROOT);
    const desc = (res.analysis || '').trim().replace(/\s+/g, ' ');
    if (desc) {
      descCache.set(imagePath, desc);
      // Logged once per image (cache miss only) so room image-describe is visible
      // in the dev terminal — it runs server-side, NOT via the analyze_image tool
      // loop, so it never shows up as a tool call in the activity log.
      console.log(`   👁️  Room image described: ${imagePath} → "${desc.slice(0, 90)}${desc.length > 90 ? '…' : ''}"`);
      return desc;
    }
    return null;
  } catch (e) {
    console.warn(`   👁️  room image describe failed for ${imagePath}:`, e instanceof Error ? e.message : e);
    return null;
  }
}

// Describe several images concurrently → { path: description } (skips failures).
export async function describeRoomImages(paths: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(paths.map(async (p) => {
    const d = await describeRoomImage(p);
    if (d) out[p] = d;
  }));
  return out;
}
