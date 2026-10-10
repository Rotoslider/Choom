/**
 * Zooming in ("look at the lower left") and sizing images for the vision model in use.
 */
import sharp from 'sharp';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { parseRegion } from '@/lib/vision-region';
import { visionInputSize } from '@/lib/vision-input-size';
import { VisionService } from '@/lib/vision-service';

const near = (r: { x: number; y: number; w: number; h: number } | null) =>
  r && Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Math.round(v * 1e6) / 1e6]));

test('named regions and nesting', () => {
  expect(parseRegion('lower left')).toEqual({ x: 0, y: 0.5, w: 0.5, h: 0.5 });
  expect(parseRegion('top half')).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
  expect(near(parseRegion('right third'))).toEqual(near({ x: 2 / 3, y: 0, w: 1 / 3, h: 1 }));
  expect(parseRegion('center')).toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
  expect(parseRegion('lower left > top right')).toEqual({ x: 0.25, y: 0.5, w: 0.25, h: 0.25 });
  expect(parseRegion('10%, 60%, 30%, 30%')).toEqual({ x: 0.1, y: 0.6, w: 0.3, h: 0.3 });
  expect(parseRegion('the thing over there')).toBeNull();
});

test('the vision model on this Mac: Gemma 4 takes its token budget, Qwen is capped', async () => {
  const gemma = await visionInputSize('google/gemma-4-26b-a4b');
  if (gemma) expect(gemma.maxPixels).toBe(280 * 48 * 48);
  const qwen = await visionInputSize('qwen/qwen3.8-27b');
  if (qwen) expect(qwen.maxPixels).toBeLessThanOrEqual(2048 * 2048);
});

test('a region is cut from the original and fills the model budget', async () => {
  // A 4000x3000 photo: left half red, right half blue; the lower-left quarter is all red.
  const w = 4000, h = 3000;
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[(y * w + x) * 3 + (x < w / 2 ? 0 : 2)] = 220;
  const root = await mkdtemp(path.join(tmpdir(), 'zoom-'));
  await writeFile(path.join(root, 'p.jpg'), await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg().toBuffer());
  let sent: Buffer | null = null;
  const realFetch = global.fetch;
  global.fetch = (async (_u: string, init: { body: string }) => {
    const url = JSON.parse(init.body).messages[0].content[1].image_url.url as string;
    sent = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const svc = new VisionService({ endpoint: 'http://v.test', model: 'google/gemma-4-26b-a4b' } as never);
    await svc.analyzeImage({ prompt: 'p', imagePath: 'p.jpg', region: 'lower left' } as never, root);
    const meta = await sharp(sent!).metadata();
    const stats = await sharp(sent!).stats();
    expect(stats.channels[0].mean).toBeGreaterThan(150); // red: the lower-left quarter
    expect(stats.channels[2].mean).toBeLessThan(40);
    expect((meta.width ?? 0) * (meta.height ?? 0)).toBeLessThanOrEqual(2048 * 2048);
    expect(svc.lastSent?.region).toEqual({ x: 0, y: 0.5, w: 0.5, h: 0.5 });
  } finally {
    global.fetch = realFetch;
  }
}, 60000);
