/**
 * Service health, Image Gen (app/api/health): it checks the engine the Chooms make pictures with, as
 * Settings > Image has it on the server, plus any Choom's own choice over it. Donny, Nov 19: the Chooms
 * use MiniMax H3 Image now, and the check still asked Forge. Every service is stubbed here; no test
 * reaches Forge, the H3 Image server or the database.
 */
jest.mock('@/lib/bridge-config-store', () => ({ loadConfig: jest.fn() }));
jest.mock('@/lib/h3-image-client', () => ({ h3Health: jest.fn() }));
jest.mock('@/lib/db', () => ({ __esModule: true, default: { choom: { findMany: jest.fn() } } }));
import { loadConfig } from '@/lib/bridge-config-store';
import { h3Health } from '@/lib/h3-image-client';
import prisma from '@/lib/db';
import { GET, POST } from '@/app/api/health/route';

const FORGE = 'http://192.168.1.23:7860';
let forgeUp: boolean;
let forgeAsked: number;
let chooms: { imageSettings: string | null }[];

beforeEach(() => {
  jest.clearAllMocks();
  forgeUp = true;
  forgeAsked = 0;
  chooms = [{ imageSettings: null }, { imageSettings: JSON.stringify({ steps: 15 }) }];
  (loadConfig as jest.Mock).mockResolvedValue({ imageGen: { endpoint: FORGE, engine: 'h3image' } });
  (prisma.choom.findMany as jest.Mock).mockImplementation(async () => chooms);
  (h3Health as jest.Mock).mockResolvedValue({ ok: true, endpoint: 'http://192.168.1.23:7870', state: 'ready', wanted: true, queued: 0 });
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith(FORGE)) {
      forgeAsked++;
      if (!forgeUp) throw new Error('ECONNREFUSED');
    }
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
});

const post = async () => {
  const res = await POST(new Request('http://localhost:3000/api/health', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoints: { imageGen: FORGE } }),
  }) as never);
  return (await res.json()).services.imageGen;
};

test('on H3 Image, the H3 Image server is checked and Forge is not', async () => {
  const r = await post();
  expect(r.status).toBe('connected');
  expect(r.details).toMatchObject({ engine: 'h3image', provider: 'MiniMax H3 Image', state: 'ready', note: 'ready' });
  expect(forgeAsked).toBe(0);
  forgeUp = false;  // Forge being down doesn't matter while nobody uses it
  expect((await post()).status).toBe('connected');
});

test('H3 Image stepped aside for a Studio render still counts as ready', async () => {
  (h3Health as jest.Mock).mockResolvedValue({ ok: true, endpoint: 'x', state: 'released', wanted: true });
  const r = await post();
  expect(r.status).toBe('connected');
  expect(r.details.note).toMatch(/Glass Studio/);
});

test('H3 Image not answering, or up with its model not loaded, is reported', async () => {
  (h3Health as jest.Mock).mockResolvedValue({ ok: false, endpoint: 'http://192.168.1.23:7870', error: 'not answering at http://192.168.1.23:7870: fetch failed' });
  let r = await post();
  expect(r.status).toBe('disconnected');
  expect(r.error).toMatch(/not answering/);
  (h3Health as jest.Mock).mockResolvedValue({ ok: true, endpoint: 'x', state: 'off', wanted: true });
  r = await post();
  expect(r.status).toBe('disconnected');
  expect(r.error).toMatch(/failed to load/);
});

test('on Forge (or no engine set), Forge is checked as before and H3 Image is not', async () => {
  (loadConfig as jest.Mock).mockResolvedValue({ imageGen: { endpoint: FORGE } });
  let r = await post();
  expect(r.status).toBe('connected');
  expect(r.details).toMatchObject({ engine: 'forge', provider: 'Forge' });
  expect(forgeAsked).toBeGreaterThan(0);
  expect(h3Health).not.toHaveBeenCalled();
  forgeUp = false;
  r = await post();
  expect(r.status).toBe('disconnected');
});

test('a Choom on her own engine keeps that engine checked too', async () => {
  chooms.push({ imageSettings: JSON.stringify({ engine: 'forge' }) });
  let r = await post();
  expect(r.status).toBe('connected');
  expect(r.details.provider).toBe('MiniMax H3 Image + Forge');
  forgeUp = false;
  r = await post();
  expect(r.status).toBe('disconnected');
  expect(r.error).toMatch(/^Forge: /);
});

test('GET ?service=imageGen goes through the same check', async () => {
  const res = await GET(new Request('http://localhost:3000/api/health?service=imageGen') as never);
  expect((await res.json()).details.engine).toBe('h3image');
});
