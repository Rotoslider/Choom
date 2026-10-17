/**
 * The Chooms asking the Looking Glass (lib/glass-closet.ts, the looking-glass skill, the glass and
 * glass/result routes) and the web app's mute reaching it, including a glass that connects (or
 * relaunches, as every build does) while the app is already muted.
 */
import { askGlass, resolveGlass } from '@/lib/glass-closet';
import { hologramMuted, setHologramMuted, subscribeHologram } from '@/lib/hologram-bus';
import { POST as glassRoute } from '@/app/api/hologram/glass/route';
import { POST as glassResult } from '@/app/api/hologram/glass/result/route';
import { POST as muteRoute } from '@/app/api/hologram/mute/route';
import { GET as eventsRoute } from '@/app/api/hologram/events/route';
import LookingGlassHandler from '@/skills/core/looking-glass/handler';
import type { SkillHandlerContext } from '@/lib/skill-handler';
import type { ToolCall } from '@/lib/types';

type Ev = Record<string, unknown>;
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://localhost:3000/x', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers } });

/** A stand-in for the hologram on the feed: records events and answers glass requests like server.py. */
function glass(answer: (e: Ev) => Record<string, unknown> | null = () => ({ ok: true, done: true, message: 'On the glass you twirl.' })) {
  const events: Ev[] = [];
  const off = subscribeHologram((e) => {
    events.push(e);
    if (e.type === 'glass_request') {
      const a = answer(e);
      if (a) resolveGlass(String(e.id), a as never);
    }
  });
  return { events, off, requests: () => events.filter((e) => e.type === 'glass_request') };
}

afterEach(() => setHologramMuted(false));

describe('askGlass', () => {
  test('no glass running: an answer at once, nothing sent', async () => {
    expect(await askGlass('Eve', 'closet')).toEqual({ ok: false, error: expect.stringMatching(/not running/) });
  });

  test('a request goes down the feed and the answer comes back by id', async () => {
    const g = glass(() => ({ ok: true, done: false, message: 'on the wish list' }));
    const answer = await askGlass('Genesis', 'wish', 'a campfire', 'move');
    g.off();
    expect(g.requests()).toEqual([expect.objectContaining({ type: 'glass_request', choom: 'Genesis', op: 'wish', what: 'a campfire', kind: 'move' })]);
    expect(String(g.requests()[0].id)).toMatch(/^[0-9a-f-]{36}$/);
    expect(answer).toEqual({ ok: true, done: false, message: 'on the wish list' });
  });

  test('no kind unless one is given', async () => {
    const g = glass();
    await askGlass('Aloy', 'move', 'twirl');
    g.off();
    expect(g.requests()[0]).not.toHaveProperty('kind');
  });

  test('no answer in time: ok false, and a late answer finds nothing waiting', async () => {
    const g = glass(() => null);
    const answer = await askGlass('Optic', 'wear', 'my denim jacket', undefined, 30);
    g.off();
    expect(answer).toEqual({ ok: false, error: expect.stringMatching(/did not answer in time/) });
    expect(resolveGlass(String(g.requests()[0].id), { ok: true })).toBe(false);
  });

  test('an unknown id resolves nothing', () => {
    expect(resolveGlass('nope', { ok: true })).toBe(false);
  });
});

describe('POST /api/hologram/glass and /glass/result', () => {
  test('asks for her and answers with what the glass said', async () => {
    const g = glass();
    const res = await glassRoute(post({ choom: ' Aloy ', op: 'move', what: 'twirl' }));
    g.off();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, done: true, message: 'On the glass you twirl.' });
    expect(g.requests()[0]).toMatchObject({ choom: 'Aloy', op: 'move', what: 'twirl' });
  });

  test('a wish is clothes unless it says move', async () => {
    const g = glass();
    await glassRoute(post({ choom: 'Eve', op: 'wish', what: 'a silk slip' }));
    await glassRoute(post({ choom: 'Eve', op: 'wish', what: 'a campfire', kind: 'move' }));
    g.off();
    expect(g.requests().map((r) => r.kind)).toEqual(['wear', 'move']);
  });

  test('bad requests, no glass, and away from home', async () => {
    expect((await glassRoute(post({ op: 'move' }))).status).toBe(400);
    expect((await glassRoute(post({ choom: 'Eve', op: 'dance' }))).status).toBe(400);
    expect((await glassRoute(post({ choom: 'Eve', op: 'closet' }))).status).toBe(503);
    expect((await glassRoute(post({ choom: 'Eve', op: 'closet' }, { host: 'abc.ngrok-free.app' }))).status).toBe(403);
  });

  test('the result route hands the answer to the waiting request', async () => {
    const g = glass(() => null);
    const asked = askGlass('Genesis', 'closet');
    const id = String(g.requests()[0].id);
    const res = await glassResult(post({ id, ok: true, moves: ['twirl'], clothes: ['your usual clothes'] }));
    g.off();
    expect(await res.json()).toEqual({ ok: true });
    expect(await asked).toEqual({ ok: true, moves: ['twirl'], clothes: ['your usual clothes'] });
    expect((await glassResult(post({ ok: true }))).status).toBe(400);
    expect((await glassResult(post({ id, ok: true }, { 'x-forwarded-for': '8.8.8.8' }))).status).toBe(403);
  });
});

describe('the looking-glass skill', () => {
  const h = new LookingGlassHandler();
  const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({ id: 't1', name, arguments: args }) as ToolCall;
  const ctx = (name: unknown = 'Genesis') => ({ choom: { name } }) as unknown as SkillHandlerContext;

  test('handles its four tools only', () => {
    expect(['glass_move', 'glass_wear', 'glass_closet', 'glass_wish'].every((t) => h.canHandle(t))).toBe(true);
    expect(h.canHandle('generate_image')).toBe(false);
  });

  test('each tool asks the glass with its own op and words', async () => {
    const g = glass();
    await h.execute(call('glass_move', { move: ' a little dance ' }), ctx());
    await h.execute(call('glass_wear', { clothes: 'my red dress' }), ctx());
    await h.execute(call('glass_closet'), ctx());
    await h.execute(call('glass_wish', { wish: 'a silk slip', kind: 'clothes' }), ctx());
    await h.execute(call('glass_wish', { wish: 'sit by a campfire', kind: 'move' }), ctx());
    g.off();
    expect(g.requests().map((r) => [r.op, r.what, r.kind ?? null])).toEqual([
      ['move', 'a little dance', null], ['wear', 'my red dress', null], ['closet', '', null],
      ['wish', 'a silk slip', 'wear'], ['wish', 'sit by a campfire', 'move'],
    ]);
    expect(new Set(g.requests().map((r) => r.choom))).toEqual(new Set(['Genesis']));
  });

  test("the glass's answer comes back to her, without its ok", async () => {
    const g = glass(() => ({ ok: true, done: true, message: 'On the glass you change into a burgundy dress.' }));
    const res = await h.execute(call('glass_wear', { clothes: 'my red dress' }), ctx());
    g.off();
    expect(res).toEqual({ toolCallId: 't1', name: 'glass_wear',
      result: { success: true, done: true, message: 'On the glass you change into a burgundy dress.' } });
  });

  test('no glass, or no name: an error she can read', async () => {
    expect((await h.execute(call('glass_closet'), ctx())).error).toMatch(/not running/);
    expect((await h.execute(call('glass_closet'), ctx(''))).error).toMatch(/which Choom/);
  });
});

describe('mute', () => {
  test('the mute route passes the press on and remembers it', async () => {
    const g = glass();
    await muteRoute(post({ muted: true }));
    expect(hologramMuted()).toBe(true);
    await muteRoute(post({ muted: false }));
    g.off();
    expect(hologramMuted()).toBe(false);
    expect(g.events.filter((e) => e.type === 'mute').map((e) => e.muted)).toEqual([true, false]);
  });

  test('a glass connecting while muted hears it first; unmuted, nothing extra', () => {
    setHologramMuted(true);
    const muted = glass();
    muted.off();
    expect(muted.events).toEqual([expect.objectContaining({ type: 'mute', muted: true })]);
    setHologramMuted(false);
    const unmuted = glass();
    unmuted.off();
    expect(unmuted.events).toEqual([]);
  });

  test('the events feed opens with the mute when the app is muted', async () => {
    setHologramMuted(true);
    const abort = new AbortController();
    const res = await eventsRoute(new Request('http://localhost:3000/api/hologram/events', { signal: abort.signal }));
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('data: ')) text += decoder.decode((await reader.read()).value);
    abort.abort();
    expect(text.startsWith(': connected\n\n')).toBe(true);
    expect(JSON.parse(text.split('data: ')[1].split('\n')[0])).toMatchObject({ type: 'mute', muted: true });
  });
});
