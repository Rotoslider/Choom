/**
 * How many pixels a vision model actually looks at, read from the model's own files in LM Studio's
 * models folder (on this machine), so images are sized to fit the model instead of a fixed 768.
 *
 *  - Gemma 4 (Gemma4ImageProcessor, or a GGUF projector "gemma4v"): a budget of soft tokens, each a
 *    (patch × pooling)² block: 280 × 48² ≈ 645,000 pixels (about 930×700 for a 4:3 photo).
 *  - Qwen-VL (Qwen2VLImageProcessor): size.longest_edge / max_pixels, a pixel count (16.7 MP for
 *    Qwen3-VL; capped below to a practical size).
 *  - Fixed-size encoders (SigLIP/CLIP): size.height × size.width, or a GGUF clip.vision.image_size².
 *
 * Answers are cached per model, so changing the vision model picks up the new model's size.
 */
import { open, readdir, readFile, stat } from 'fs/promises';
import os from 'os';
import path from 'path';

const MODELS_DIR = process.env.LMSTUDIO_MODELS_DIR || path.join(os.homedir(), '.lmstudio', 'models');
/** Above this a vision pass gets slow and fills the context for little gain (2048×2048). */
export const PRACTICAL_MAX_PIXELS = 2048 * 2048;
const GEMMA4_DEFAULT_TOKENS = 280;

export interface VisionInputSize {
  /** Pixels to send: the model's own size, capped at PRACTICAL_MAX_PIXELS. */
  maxPixels: number;
  /** The model's own size, before the cap. */
  nativePixels: number;
  /** Where it was read from, for the settings page and logs. */
  source: string;
}

const cache = new Map<string, VisionInputSize | null>();

export async function visionInputSize(modelId: string): Promise<VisionInputSize | null> {
  if (!modelId) return null;
  if (cache.has(modelId)) return cache.get(modelId)!;
  let found: VisionInputSize | null = null;
  try {
    for (const dir of await modelFolders(modelId)) {
      found = (await fromProcessorConfig(dir)) ?? (await fromGgufProjector(dir));
      if (found) break;
    }
  } catch {
    found = null;
  }
  cache.set(modelId, found);
  return found;
}

/** LM Studio folders (publisher/model) whose name contains the model id's name, best match first. */
async function modelFolders(modelId: string): Promise<string[]> {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9.]+/g, '');
  const want = norm(modelId.split('/').pop() || modelId);
  if (!want) return [];
  const out: string[] = [];
  for (const publisher of await readdir(MODELS_DIR).catch(() => [] as string[])) {
    const pdir = path.join(MODELS_DIR, publisher);
    if (!(await stat(pdir).catch(() => null))?.isDirectory()) continue;
    for (const name of await readdir(pdir).catch(() => [] as string[])) {
      if (norm(name).includes(want)) out.push(path.join(pdir, name));
    }
  }
  return out.sort((a, b) => a.length - b.length);
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try { return JSON.parse(await readFile(file, 'utf-8')); } catch { return null; }
}

function result(nativePixels: number, source: string): VisionInputSize {
  return { nativePixels, maxPixels: Math.min(nativePixels, PRACTICAL_MAX_PIXELS), source };
}

async function fromProcessorConfig(dir: string): Promise<VisionInputSize | null> {
  const processor = await readJson(path.join(dir, 'processor_config.json'));
  const pre = await readJson(path.join(dir, 'preprocessor_config.json'));
  const ip = ((processor?.image_processor as Record<string, unknown>) ?? pre ?? processor) as Record<string, any> | null;
  if (!ip) return null;
  const type = String(ip.image_processor_type || '');
  if (typeof ip.max_soft_tokens === 'number' && typeof ip.patch_size === 'number') {
    const block = ip.patch_size * (Number(ip.pooling_kernel_size) || 1);
    return result(ip.max_soft_tokens * block * block, `${type || 'image processor'}: ${ip.max_soft_tokens} tokens × ${block}² px`);
  }
  const size = (ip.size ?? {}) as Record<string, number>;
  if (/Qwen/i.test(type) || typeof ip.max_pixels === 'number') {
    const px = Number(ip.max_pixels) || Number(size.longest_edge) || 0;
    if (px > 0) return result(px, `${type}: up to ${px.toLocaleString()} px`);
  }
  if (size.height && size.width) return result(size.height * size.width, `${type || 'image processor'}: ${size.width}×${size.height}`);
  if (size.shortest_edge && !/Qwen/i.test(type)) return result(size.shortest_edge ** 2, `${type || 'image processor'}: ${size.shortest_edge}²`);
  return null;
}

/** A GGUF model's vision projector (mmproj-*.gguf): its clip.vision.* metadata. */
async function fromGgufProjector(dir: string): Promise<VisionInputSize | null> {
  const file = (await readdir(dir).catch(() => [] as string[])).find((f) => /mmproj.*\.gguf$/i.test(f));
  if (!file) return null;
  const meta = await readGgufMetadata(path.join(dir, file), /^clip\.vision\.(image_size|patch_size|projector_type|image_max_pixels)$/);
  const projector = String(meta['clip.vision.projector_type'] || '');
  if (projector === 'gemma4v') {
    const block = (Number(meta['clip.vision.patch_size']) || 16) * 3;
    return result(GEMMA4_DEFAULT_TOKENS * block * block, `GGUF ${projector}: ${GEMMA4_DEFAULT_TOKENS} tokens × ${block}² px`);
  }
  if (typeof meta['clip.vision.image_max_pixels'] === 'number') return result(meta['clip.vision.image_max_pixels'] as number, `GGUF ${projector}`);
  const side = Number(meta['clip.vision.image_size']);
  return side > 0 ? result(side * side, `GGUF ${projector || 'clip'}: ${side}²`) : null;
}

/** Reads GGUF key/value metadata (only the keys matching `want`; stops at the tensor list). */
async function readGgufMetadata(file: string, want: RegExp): Promise<Record<string, unknown>> {
  const fh = await open(file, 'r');
  try {
    const head = Buffer.alloc(4 * 1024 * 1024);
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    const b = head.subarray(0, bytesRead);
    if (b.toString('ascii', 0, 4) !== 'GGUF') return {};
    let o = 8;
    const u64 = () => { const v = Number(b.readBigUInt64LE(o)); o += 8; return v; };
    const str = () => { const n = u64(); const s = b.toString('utf8', o, o + n); o += n; return s; };
    const fixed: Record<number, [number, (at: number) => unknown]> = {
      0: [1, (at) => b.readUInt8(at)], 1: [1, (at) => b.readInt8(at)], 2: [2, (at) => b.readUInt16LE(at)],
      3: [2, (at) => b.readInt16LE(at)], 4: [4, (at) => b.readUInt32LE(at)], 5: [4, (at) => b.readInt32LE(at)],
      6: [4, (at) => b.readFloatLE(at)], 7: [1, (at) => b.readUInt8(at) !== 0], 10: [8, (at) => Number(b.readBigUInt64LE(at))],
      11: [8, (at) => Number(b.readBigInt64LE(at))], 12: [8, (at) => b.readDoubleLE(at)],
    };
    const value = (t: number): unknown => {
      if (t === 8) return str();
      if (t === 9) {
        const it = b.readUInt32LE(o); o += 4;
        const n = u64();
        const items: unknown[] = [];
        for (let i = 0; i < n; i++) items.push(value(it));
        return items;
      }
      const [size, read] = fixed[t];
      const v = read(o); o += size;
      return v;
    };
    u64(); // tensor count
    const count = u64();
    const out: Record<string, unknown> = {};
    for (let i = 0; i < count && o < b.length - 16; i++) {
      const key = str();
      const t = b.readUInt32LE(o); o += 4;
      const v = value(t);
      if (want.test(key)) out[key] = v;
    }
    return out;
  } finally {
    await fh.close();
  }
}
