/**
 * Live model metadata — ask the serving endpoint what a model's context
 * window actually is, instead of trusting the hand-maintained profile list.
 *
 * Why: the 2026-08-05 audit found 12 of 33 matchable built-in profiles stale.
 * deepseek-v4 pro/flash were understated 8x (131k listed, 1,048,576 real),
 * the gemma-4 windows were carried over from gemma-3 (128k listed, 262,144
 * native), and none of the 93 OpenRouter models with 1M+ windows exist in the
 * list at all. Static configs are guesses that rot; the providers publish the
 * truth:
 *
 *  - LM Studio (local endpoints): GET {base}/api/v0/models →
 *    `loaded_context_length` is the window the model is ACTUALLY loaded at
 *    (RAM-capped loads included — a 262k-native model loaded at 131k really
 *    has 131k). Falls back to `max_context_length` for unloaded models.
 *  - OpenRouter: GET https://openrouter.ai/api/v1/models (public, no key) →
 *    `context_length` per model id.
 *  - Everything else (NVIDIA NIM publishes no window metadata; Anthropic
 *    windows live in their static profiles): returns null and the static
 *    profile / user setting stays authoritative.
 *
 * Fail-soft by design: a chat turn must never block or break on metadata.
 * Short timeout, per-endpoint cache (1h TTL), and stale-ok — if a refresh
 * fails, the last good answer keeps serving.
 */

import { normalizeModelId } from './model-profiles';

const TTL_MS = 60 * 60 * 1000; // refresh hourly
const RETRY_MS = 5 * 60 * 1000; // after a failure, don't re-poke for 5 min
const FETCH_TIMEOUT_MS = 4000;

interface EndpointCache {
  fetchedAt: number; // last successful fetch (0 = never)
  failedAt: number; // last failed attempt (0 = never)
  windows: Map<string, number>; // modelId -> context window
}

const cache = new Map<string, EndpointCache>();

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

function isOpenRouter(endpoint: string): boolean {
  return endpoint.includes('openrouter.ai');
}

/** Private-network / loopback endpoints are where LM Studio lives. */
function isPrivateEndpoint(endpoint: string): boolean {
  return /(?:localhost|127\.0\.0\.1|192\.168\.|10\.\d|172\.(?:1[6-9]|2\d|3[01])\.)/.test(endpoint);
}

async function fetchJson(url: string): Promise<unknown> {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(to);
  }
}

async function loadWindows(endpoint: string): Promise<Map<string, number>> {
  const windows = new Map<string, number>();
  if (isOpenRouter(endpoint)) {
    const j = (await fetchJson(OPENROUTER_MODELS_URL)) as { data?: Array<{ id?: string; context_length?: number }> };
    for (const m of j.data || []) {
      if (m.id && typeof m.context_length === 'number' && m.context_length > 0) {
        windows.set(m.id, m.context_length);
      }
    }
  } else if (isPrivateEndpoint(endpoint)) {
    // LM Studio REST API lives beside the OpenAI-compat namespace.
    const base = endpoint.replace(/\/v1\/?$/, '');
    const j = (await fetchJson(`${base}/api/v0/models`)) as {
      data?: Array<{ id?: string; state?: string; max_context_length?: number; loaded_context_length?: number }>;
    };
    for (const m of j.data || []) {
      const w = m.loaded_context_length || m.max_context_length;
      if (m.id && typeof w === 'number' && w > 0) windows.set(m.id, w);
    }
  }
  return windows;
}

/**
 * The model's real context window as reported by its serving endpoint, or
 * null when the endpoint publishes nothing (then profiles/settings decide).
 * Matches exact model id first, then the same normalized comparison the
 * profile lookup uses (org prefix + tune/quant suffixes stripped).
 */
export async function getLiveContextWindow(
  modelId: string,
  endpoint: string | undefined,
): Promise<number | null> {
  if (!modelId || !endpoint) return null;
  if (!isOpenRouter(endpoint) && !isPrivateEndpoint(endpoint)) return null;

  let entry = cache.get(endpoint);
  const now = Date.now();
  const fresh = entry && now - entry.fetchedAt < TTL_MS;
  const recentlyFailed = entry && now - entry.failedAt < RETRY_MS;

  if (!fresh && !recentlyFailed) {
    try {
      const windows = await loadWindows(endpoint);
      entry = { fetchedAt: now, failedAt: 0, windows };
      cache.set(endpoint, entry);
    } catch (err) {
      // Stale-ok: keep serving the last good map; just note the failure so we
      // don't hammer a down endpoint on every turn.
      if (entry) {
        entry.failedAt = now;
      } else {
        entry = { fetchedAt: 0, failedAt: now, windows: new Map() };
        cache.set(endpoint, entry);
      }
      console.warn(`[ModelMetadata] ${endpoint}: ${err instanceof Error ? err.message : err} — using ${entry.fetchedAt ? 'stale cache' : 'static profiles'}`);
    }
  }

  const windows = entry?.windows;
  if (!windows || windows.size === 0) return null;

  const exact = windows.get(modelId);
  if (exact) return exact;
  const norm = normalizeModelId(modelId);
  for (const [id, w] of windows) {
    if (normalizeModelId(id) === norm) return w;
  }
  return null;
}

/** Test hook: clear the per-endpoint cache. */
export function _resetModelMetadataCache(): void {
  cache.clear();
}
