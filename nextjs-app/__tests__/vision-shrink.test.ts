/**
 * A phone photo over the old 10 MB limit (Donny's rack photos over Signal were 21.9 MB) is shrunk
 * first and reaches the vision model, upright and small.
 */
import sharp from 'sharp';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { VisionService } from '@/lib/vision-service';

test('a 20+ MB photo is shrunk and analyzed instead of refused', async () => {
  const w = 4000, h = 3000;
  const noise = Buffer.alloc(w * h * 3);
  for (let i = 0; i < noise.length; i++) noise[i] = (Math.imul(i, 2654435761) >>> 24) & 255; // incompressible
  const big = await sharp(noise, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 100 }).toBuffer();
  expect(big.length).toBeGreaterThan(10 * 1024 * 1024);
  const root = await mkdtemp(path.join(tmpdir(), 'vision-'));
  await writeFile(path.join(root, 'rack.jpg'), big);

  let sentBytes = 0;
  let sentMime = '';
  const realFetch = global.fetch;
  global.fetch = (async (_url: string, init: { body: string }) => {
    const url = JSON.parse(init.body).messages[0].content[1].image_url.url as string;
    sentMime = url.slice(5, url.indexOf(';'));
    sentBytes = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64').length;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'a server rack' } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const vision = new VisionService({ endpoint: 'http://vision.test', model: 'm' } as never);
    const out = await vision.analyzeImage({ prompt: 'what is this', imagePath: 'rack.jpg' } as never, root);
    expect(out.analysis).toBe('a server rack');
    expect(sentMime).toBe('image/jpeg');
    expect(sentBytes).toBeLessThan(2 * 1024 * 1024);
  } finally {
    global.fetch = realFetch;
  }
}, 60000);
