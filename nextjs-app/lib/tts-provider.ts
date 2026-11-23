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
import prisma from './db';

export interface TTSProvider {
  id: string;
  name: string;
  endpoint: string;
  notes?: string;
  /** Takes delivery cues like "[warm]" (Drama 3). An endpoint ending in /drama counts too. */
  voiceCues?: boolean;
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

/** Whether a provider's engine takes delivery cues (Drama 3, through the TTS bridge's /drama route). */
export function providerTakesVoiceCues(p: Pick<TTSProvider, 'endpoint' | 'voiceCues'> | null | undefined): boolean {
  return !!p && (p.voiceCues === true || /\/drama\/?$/.test(p.endpoint || ''));
}

/** Whether the Choom pinned to this provider should be told about delivery cues. */
export async function choomTakesVoiceCues(ttsProviderId: string | null | undefined): Promise<boolean> {
  if (!ttsProviderId) return false;
  return providerTakesVoiceCues((await listTTSProviders()).find((p) => p.id === ttsProviderId));
}

// voice → that Choom's provider pin, for callers that know only the voice (the
// Looking Glass hologram asks /api/tts with {text, voice}). Cached briefly: the
// glass asks once per sentence.
let voicePins: { at: number; pins: Map<string, string | null> } | null = null;
const VOICE_PIN_TTL_MS = 30_000;

/**
 * Endpoint for a voice with no endpoint of its own: the provider pinned on the
 * Choom who speaks in that voice, else `globalEndpoint`. Each Choom has her own
 * voice; if two shared one, the first with a pin wins.
 */
export async function resolveTTSEndpointForVoice(voice: string | null | undefined, globalEndpoint?: string): Promise<string> {
  const fallback = globalEndpoint || DEFAULT_TTS_ENDPOINT;
  if (!voice) return fallback;
  try {
    if (!voicePins || Date.now() - voicePins.at > VOICE_PIN_TTL_MS) {
      const chooms = await prisma.choom.findMany({ select: { voiceId: true, ttsProviderId: true } });
      const pins = new Map<string, string | null>();
      for (const c of chooms) {
        if (!c.voiceId) continue;
        if (!pins.get(c.voiceId)) pins.set(c.voiceId, c.ttsProviderId || null);
      }
      voicePins = { at: Date.now(), pins };
    }
    return await resolveTTSEndpoint(voicePins.pins.get(voice) ?? null, fallback);
  } catch (e) {
    console.warn(`   ⚠️ voice → TTS provider lookup failed (${e}) — using ${fallback}`);
    return fallback;
  }
}
