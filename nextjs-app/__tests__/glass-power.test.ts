/**
 * The Glass button (lib/glass-power.ts, /api/hologram/power): the picture off to save power, kept
 * across restarts, told to every glass that connects, and confirmed by the glass's heartbeat.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { glassOff, glassReported, setGlassOff } from '@/lib/glass-power';
import { subscribeHologram } from '@/lib/hologram-bus';
import { GET as powerGet, POST as powerPost } from '@/app/api/hologram/power/route';
import { POST as voicePost } from '@/app/api/hologram/voice/route';
import { GET as eventsRoute } from '@/app/api/hologram/events/route';

const post = (body: unknown) =>
  new Request('http://localhost:3000/x', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
const store = globalThis as unknown as { __choomGlassOff?: boolean; __choomGlassReported?: unknown };

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glass-power-'));
  process.env.CHOOM_GLASS_POWER_FILE = path.join(dir, 'glass-power.json');
  delete store.__choomGlassOff; // as if the app had just started
  delete store.__choomGlassReported;
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.CHOOM_GLASS_POWER_FILE;
  jest.restoreAllMocks();
});

test('on until pressed; off is saved and survives a restart of the app', () => {
  expect(glassOff()).toBe(false);
  setGlassOff(true);
  expect(JSON.parse(fs.readFileSync(process.env.CHOOM_GLASS_POWER_FILE!, 'utf8')).off).toBe(true);
  delete store.__choomGlassOff; // restart
  expect(glassOff()).toBe(true);
});

test('pressing it tells the glass on the feed', () => {
  const events: Record<string, unknown>[] = [];
  const unsubscribe = subscribeHologram((e) => events.push(e));
  setGlassOff(true);
  setGlassOff(false);
  unsubscribe();
  expect(events.map((e) => [e.type, e.off])).toEqual([['glass_power', true], ['glass_power', false]]);
});

test('a glass connecting to the feed hears the state first, on or off', async () => {
  setGlassOff(true);
  const abort = new AbortController();
  const res = await eventsRoute(new Request('http://localhost:3000/api/hologram/events', { signal: abort.signal }));
  const reader = res.body!.getReader();
  let text = '';
  while (!text.includes('glass_power')) text += new TextDecoder().decode((await reader.read()).value);
  abort.abort();
  expect(text).toMatch(/"type":"glass_power","off":true/);
});

test('the route: off/on, a bad body refused, the glass confirming in its heartbeat', async () => {
  expect(await (await powerGet()).json()).toEqual({ off: false, glass: null });
  expect((await powerPost(post({ off: 'yes' }))).status).toBe(400);
  expect(await (await powerPost(post({ off: true }))).json()).toEqual({ off: true, glass: null });
  await voicePost(post({ voice: true, glassOff: true }));
  expect(glassReported()).toBe(true);
  expect(await (await powerGet()).json()).toEqual({ off: true, glass: 'off' });
  await voicePost(post({ voice: true })); // an older glass that doesn't say: the last word stands
  expect(await (await powerGet()).json()).toEqual({ off: true, glass: 'off' });
});
