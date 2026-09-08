// Resolving which TTS server speaks for a given Choom.
//
// Each Choom may be pinned to one of settings.ttsProviders[] via
// Choom.ttsProviderId — so Genesis can stay on a proven engine while another
// Choom runs an experimental one, or work can be spread across hosts. When a
// Choom has no pin (or the pin no longer resolves) we fall back to the global
// tts.endpoint, which is exactly the behaviour from before this existed.
//
// Note this is only about *which server*: a single server switching between
// voices costs nothing, because the reference clip travels with the request
// rather than being baked into a loaded model. Pin a Choom elsewhere to use a
// different engine, not to make turn-taking faster.

import { loadConfig } from './bridge-config-store';

export interface TTSProvider {
  id: string;
  name: string;
  endpoint: string;
  notes?: string;
}

export const DEFAULT_TTS_ENDPOINT = process.env.TTS_ENDPOINT || 'http://localhost:8004';

export async function listTTSProviders(): Promise<TTSProvider[]> {
  try {
    const cfg = await loadConfig();
    const raw = (cfg as Record<string, unknown>).ttsProviders;
    return Array.isArray(raw) ? (raw as TTSProvider[]) : [];
  } catch {
    return [];
  }
}

/**
 * Endpoint for a Choom's TTS, given its ttsProviderId.
 * `globalEndpoint` is the caller's already-resolved default (settings.tts.endpoint).
 */
export async function resolveTTSEndpoint(
  ttsProviderId: string | null | undefined,
  globalEndpoint?: string,
): Promise<string> {
  const fallback = globalEndpoint || DEFAULT_TTS_ENDPOINT;
  if (!ttsProviderId) return fallback;
  const provider = (await listTTSProviders()).find((p) => p.id === ttsProviderId);
  if (!provider?.endpoint) {
    // A deleted or renamed provider must not silence a Choom.
    console.warn(`   ⚠️ ttsProviderId "${ttsProviderId}" not found — using ${fallback}`);
    return fallback;
  }
  return provider.endpoint;
}
