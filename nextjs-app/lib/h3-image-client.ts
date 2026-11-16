/**
 * MiniMax H3 Image: the second image engine beside Forge's Flux.2 Klein (Settings > Image > Image engine).
 *
 * It runs on the NUC (hologram/studio/h3image_server.py, port 7870), which keeps the model loaded
 * between pictures (about 35-60 s a picture) and takes turns with Glass Studio's clip renders: a render
 * steps aside once the clip it's on has landed, so a picture asked for mid-render can wait a few minutes.
 * Hence a job here, polled, rather than one long request.
 *
 * H3 Image has one fixed recipe (6 steps, no CFG, no negative prompt, no LoRAs), so the Chooms' Klein
 * settings (checkpoint, steps, sampler, scheduler, hires-fix) don't apply to it and stay as they are for
 * switching back. Size, aspect and reference pictures apply to both. References are named in the prompt
 * as <Picture 1>, <Picture 2>... in the order they are sent: h3ReferenceLead says who each one is.
 *
 * Nov 15 2026, Donny's five worst Klein selfies (extra legs, a third arm, a mangled foot) at four seeds
 * each: Klein drew extra limbs in 6 of 20, H3 Image in none, with better faces and fingers.
 */
import type { ImageGenSettings, ImageGenerationSettings } from './types';
import { loadConfig } from './bridge-config-store';

export const H3_IMAGE_PORT = 7870;
const POLL_WAIT_S = 50;              // the server holds each poll up to this long
const MAX_WAIT_MS = 25 * 60_000;     // a render's clip (a few minutes) + loading + the picture

export interface ReferenceSubject {
  name: string;
  count: number; // how many of the reference pictures, in order, are of this subject
}

/** The server's address: Settings, else H3_IMAGE_ENDPOINT, else Forge's host on port 7870. */
export function h3Endpoint(settings: Partial<ImageGenSettings>): string {
  const own = settings.h3Endpoint?.trim() || process.env.H3_IMAGE_ENDPOINT?.trim();
  if (own) return own.replace(/\/+$/, '');
  try {
    const url = new URL(settings.endpoint || 'http://localhost:7860');
    url.port = String(H3_IMAGE_PORT);
    return url.origin;
  } catch {
    return `http://localhost:${H3_IMAGE_PORT}`;
  }
}

/**
 * Who each reference picture is, ahead of the prompt: "Reference pictures: <Picture 1> and <Picture 2>
 * show Genesis; <Picture 3> shows Donny. ..." Pictures past the named subjects (pinned extras) are
 * "further references".
 */
export function h3ReferenceLead(subjects: ReferenceSubject[], total: number): string {
  if (total <= 0) return '';
  const parts: string[] = [];
  let n = 0;
  for (const s of subjects) {
    const count = Math.min(Math.max(0, Math.floor(s.count)), total - n);
    if (count <= 0) continue;
    const nums = Array.from({ length: count }, () => `<Picture ${++n}>`);
    parts.push(`${nums.join(' and ')} show${count === 1 ? 's' : ''} ${s.name}`);
  }
  if (n < total) {
    const rest = Array.from({ length: total - n }, () => `<Picture ${++n}>`);
    parts.push(`${rest.join(' and ')} ${rest.length === 1 ? 'is a further reference' : 'are further references'}`);
  }
  return `Reference pictures: ${parts.join('; ')}. The target image is a new picture of them, keeping their faces and looks exactly as in those pictures: `;
}

function authHeaders(): Record<string, string> {
  const token = process.env.H3_IMAGE_TOKEN?.trim();
  if (!token) {
    throw new Error('H3 Image needs H3_IMAGE_TOKEN in .env (the token in ~/.config/choom-h3image/token on the NUC)');
  }
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

export async function generateWithH3(
  settings: Partial<ImageGenSettings>,
  req: ImageGenerationSettings
): Promise<{ imageUrl: string; seed: number; settings: ImageGenerationSettings }> {
  const base = h3Endpoint(settings);
  const headers = authHeaders();
  const references = req.referenceImages || [];
  const prompt = h3ReferenceLead(req.referenceSubjects || [], references.length) + req.prompt;
  const start = await fetch(`${base}/jobs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      prompt,
      width: req.width,
      height: req.height,
      seed: typeof req.seed === 'number' && req.seed >= 0 ? req.seed : -1,
      references,
      label: req.label || 'a Choom picture',
    }),
  }).catch((e: unknown) => {
    throw new Error(`H3 Image server at ${base} is not answering (${e instanceof Error ? e.message : e}). Switch the image engine back to Klein in Settings if it stays down.`);
  });
  if (!start.ok) throw new Error(`H3 Image server refused the picture: ${start.status} ${(await start.text()).slice(0, 300)}`);
  const { id } = (await start.json()) as { id: string };
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/jobs/${id}?wait=${POLL_WAIT_S}`, { headers });
    if (!res.ok) throw new Error(`H3 Image server lost the picture: ${res.status} ${(await res.text()).slice(0, 300)}`);
    const job = (await res.json()) as {
      status: string; image?: string; seed?: number; width?: number; height?: number; ms?: number; waitedMs?: number; error?: string;
    };
    if (job.status === 'done' && job.image) {
      const seed = job.seed ?? -1;
      if ((job.waitedMs ?? 0) > 5000) console.log(`   ⏳ H3 Image waited ${Math.round((job.waitedMs ?? 0) / 1000)}s for the GPU (a clip render stepping aside)`);
      console.log(`   🎨 H3 Image: ${job.width}x${job.height} in ${Math.round((job.ms ?? 0) / 1000)}s`);
      return {
        imageUrl: `data:image/png;base64,${job.image}`,
        seed,
        settings: {
          ...req,
          referenceImages: undefined,
          seed,
          width: job.width ?? req.width,
          height: job.height ?? req.height,
          engine: 'h3image',
          checkpoint: 'MiniMax H3 Image (pruned 20B)',
          steps: 6,
          cfgScale: 1,
          sampler: 'euler',
          scheduler: undefined,
          distilledCfg: undefined,
          negativePrompt: undefined,
          hiresFix: undefined,
        },
      };
    }
    if (job.status === 'failed') throw new Error(`H3 Image failed: ${job.error || 'no reason given'}`);
  }
  throw new Error(`H3 Image took over ${MAX_WAIT_MS / 60_000} minutes`);
}

/**
 * The engine as the server has it (bridge-config.json, which Settings writes): a request's own settings
 * can come from a browser tab opened before the switch, so the server's choice wins. Never throws.
 */
export async function withServerEngine<T extends Partial<ImageGenSettings>>(settings: T): Promise<T> {
  try {
    const server = ((await loadConfig()) as Record<string, unknown>).imageGen as Partial<ImageGenSettings> | undefined;
    if (!server?.engine) return settings;
    return { ...settings, engine: server.engine, h3Endpoint: server.h3Endpoint || settings.h3Endpoint };
  } catch {
    return settings;
  }
}

export interface H3Health {
  ok: boolean;
  endpoint?: string;
  state?: 'off' | 'loading' | 'ready' | 'busy' | 'released';
  wanted?: boolean;
  queued?: number;
  last?: Record<string, unknown>;
  error?: string;
}

export async function h3Health(settings: Partial<ImageGenSettings>): Promise<H3Health> {
  const base = h3Endpoint(settings);
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
    return { ...((await res.json()) as H3Health), endpoint: base };
  } catch (e) {
    return { ok: false, endpoint: base, error: `not answering at ${base}: ${e instanceof Error ? e.message : e}` };
  }
}

/**
 * The engine changed in Settings. To H3 Image: load it now, so the first picture doesn't wait for it.
 * To Klein: H3 Image lets go of the GPU and its 32 GB of RAM, and stays off. Never throws.
 */
export async function applyEngineSwitch(settings: Partial<ImageGenSettings>): Promise<string> {
  const base = h3Endpoint(settings);
  try {
    const path = settings.engine === 'h3image' ? '/load' : '/release';
    const body = settings.engine === 'h3image' ? {} : { off: true };
    const res = await fetch(`${base}${path}`, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
    const msg = `H3 Image ${settings.engine === 'h3image' ? 'loading' : 'released'}: ${res.status}`;
    console.log(`   🎨 Image engine is now ${settings.engine === 'h3image' ? 'MiniMax H3 Image' : 'Forge (Klein)'}; ${msg}`);
    return msg;
  } catch (e) {
    const msg = `could not reach the H3 Image server: ${e instanceof Error ? e.message : e}`;
    console.warn(`   ⚠️ Image engine switch: ${msg}`);
    return msg;
  }
}
