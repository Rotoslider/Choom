/**
 * The hologram's two routes into a conversation: the welcome back (/api/hologram/welcome), with the
 * rooms it pauses, and talking at the tower (/api/hologram/talk), with the chat or room it picks.
 * Runs the real routes against a scratch database; the calls they make onward (/api/chat,
 * /api/group-chat) are caught by a stand-in fetch.
 */
jest.mock('@/lib/db', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prisma } = require('./helpers/scratch-db');
  return { __esModule: true, default: prisma, prisma };
});
const mockSettings = jest.fn(async () => new Response(JSON.stringify({ llm: { model: 'test' } })));
jest.mock('@/app/api/settings/defaults/route', () => ({ GET: () => mockSettings() }));
const mockReadFile = jest.fn();
jest.mock('fs/promises', () => {
  const actual = jest.requireActual('fs/promises');
  return { ...actual, readFile: (...args: unknown[]) => mockReadFile(...args) ?? actual.readFile(...args) };
});

import { prisma, teardown } from './helpers/scratch-db';
import { POST as welcome } from '@/app/api/hologram/welcome/route';
import { POST as talk } from '@/app/api/hologram/talk/route';

jest.setTimeout(30_000);

type Call = { url: string; method: string; body: Record<string, unknown> };
let calls: Call[] = [];
let chatAnswer: () => Promise<Response> = async () => streamed();
const streamed = () => new Response(new ReadableStream({ start(c) { c.close(); } }), { status: 200 });

beforeEach(() => {
  calls = [];
  chatAnswer = async () => streamed();
  mockSettings.mockClear();
  mockReadFile.mockReset();
  global.fetch = jest.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(init.body) : {};
    calls.push({ url, method: init?.method ?? 'GET', body });
    if (url.endsWith('/api/group-chat') && init?.method === 'PUT') {
      return new Response(JSON.stringify(body.pause ? { pausing: [{ roomId: 'r1', speaker: 'Aloy' }] } : { resumed: ['r1'], carriedOn: [] }));
    }
    if (url.endsWith('/api/chat') || url.endsWith('/api/group-chat')) return chatAnswer();
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
});
afterAll(teardown);

const req = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost:3000${url}`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers } });
const pauses = () => calls.filter((c) => c.method === 'PUT').map((c) => (c.body.pause ? 'pause' : 'resume'));

let genesis: string;
let eve: string;
beforeAll(async () => {
  genesis = (await prisma.choom.create({ data: { name: 'Genesis' } })).id;
  eve = (await prisma.choom.create({ data: { name: 'Eve' } })).id;
});

describe('welcome back', () => {
  let chatId: string;
  beforeAll(async () => {
    chatId = (await prisma.chat.create({ data: { choomId: genesis, title: 'Shop day', lastUserMessageAt: new Date(Date.now() - 30 * 60_000) } })).id;
  });

  test('pauses the rooms, then sends her the note in the chat he last talked in', async () => {
    const res = await welcome(req('/api/hologram/welcome', { awayMinutes: 24, place: 'shop' }));
    expect(await res.json()).toEqual({ ok: true, choom: 'Genesis', chatId, pausing: [{ roomId: 'r1', speaker: 'Aloy' }] });
    expect(pauses()).toEqual(['pause']);
    const chat = calls.find((c) => c.url.endsWith('/api/chat'))!;
    expect(calls.indexOf(chat)).toBeGreaterThan(calls.findIndex((c) => c.method === 'PUT'));
    expect(chat.body).toMatchObject({ choomId: genesis, chatId, note: true, settings: { llm: { model: 'test' } } });
    expect(String(chat.body.message)).toMatch(/^\[Note from the house, not from Donny: .*about 24 minutes away \(he was in the shop\)/);
  });

  test('{ done } picks the rooms up again', async () => {
    expect(await (await welcome(req('/api/hologram/welcome', { done: true }))).json()).toEqual({ ok: true, resumed: ['r1'], carriedOn: [] });
    expect(pauses()).toEqual(['resume']);
  });

  test('the chat answers with an error: no welcome, and the rooms pick up again at once', async () => {
    chatAnswer = async () => new Response('busy', { status: 500 });
    const res = await welcome(req('/api/hologram/welcome', { awayMinutes: 30 }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: 'chat answered 500' });
    expect(pauses()).toEqual(['pause', 'resume']);
  });

  test('the chat cannot be reached: the rooms pick up again', async () => {
    chatAnswer = async () => { throw new Error('connection refused'); };
    const res = await welcome(req('/api/hologram/welcome', { awayMinutes: 30 }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('connection refused');
    expect(pauses()).toEqual(['pause', 'resume']);
  });

  test('the settings fail to load: the rooms pick up again', async () => {
    mockSettings.mockImplementationOnce(async () => { throw new Error('settings unreadable'); });
    const res = await welcome(req('/api/hologram/welcome', { awayMinutes: 30 }));
    expect(res.status).toBe(502);
    expect(pauses()).toEqual(['pause', 'resume']);
  });

  test('a dry run, a missing time, and away from home touch no room', async () => {
    expect(await (await welcome(req('/api/hologram/welcome', { awayMinutes: 30, dryRun: true }))).json())
      .toEqual({ ok: true, dryRun: true, choom: 'Genesis', chatId, chatTitle: 'Shop day' });
    expect((await welcome(req('/api/hologram/welcome', {}))).status).toBe(400);
    expect((await welcome(req('/api/hologram/welcome', { awayMinutes: 30 }, { host: 'x.ngrok-free.app' }))).status).toBe(403);
    expect(calls).toEqual([]);
  });

  test('no conversation in 12 hours: nothing paused, nothing sent', async () => {
    await prisma.chat.update({ where: { id: chatId }, data: { lastUserMessageAt: new Date(Date.now() - 13 * 3600_000) } });
    expect(await (await welcome(req('/api/hologram/welcome', { awayMinutes: 30 }))).json())
      .toEqual({ ok: false, skipped: 'no conversation in the last 12 hours' });
    expect(calls).toEqual([]);
    await prisma.chat.update({ where: { id: chatId }, data: { lastUserMessageAt: new Date(Date.now() - 30 * 60_000) } });
  });
});

describe('talking at the tower', () => {
  const ago = (min: number) => new Date(Date.now() - min * 60_000);

  test("her current 1:1 chat, not a delegation, autonomous, briefing, scratch or archived one", async () => {
    const mine = await prisma.chat.create({ data: { choomId: eve, title: 'Overalls talk', updatedAt: ago(60) } });
    for (const [title, min] of [['[Delegation] look at the gate', 1], ['[Autonomous] evening check', 2], ['Briefing Oct 16', 3], ['notes [group scratch]', 4]] as const) {
      await prisma.chat.create({ data: { choomId: eve, title, updatedAt: ago(min) } });
    }
    await prisma.chat.create({ data: { choomId: eve, title: 'old one', archived: true, updatedAt: ago(0) } });
    const res = await talk(req('/api/hologram/talk', { choom: 'eve', text: 'how was your day?', dryRun: true }));
    expect(await res.json()).toEqual({ ok: true, dryRun: true, choom: 'Eve', chatId: mine.id, chatTitle: 'Overalls talk' });
  });

  test('his words go to that chat as a message he started', async () => {
    const res = await talk(req('/api/hologram/talk', { choom: 'Eve', text: 'how was your day?' }));
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, choom: 'Eve' });
    expect(calls.find((c) => c.url.endsWith('/api/chat'))!.body)
      .toMatchObject({ choomId: eve, chatId: body.chatId, message: 'how was your day?', userInitiated: true });
  });

  test('none of hers fits: a new chat', async () => {
    const aloy = (await prisma.choom.create({ data: { name: 'Aloy' } })).id;
    await prisma.chat.create({ data: { choomId: aloy, title: '[Delegation] weather' } });
    const res = await talk(req('/api/hologram/talk', { choom: 'Aloy', text: 'hi', dryRun: true }));
    const { chatId } = await res.json();
    expect((await prisma.chat.findUnique({ where: { id: chatId } }))!.title).toBeNull();
  });

  test('unknown Choom, missing words, away from home', async () => {
    expect((await talk(req('/api/hologram/talk', { choom: 'Nova', text: 'hi' }))).status).toBe(404);
    expect((await talk(req('/api/hologram/talk', { choom: 'Eve' }))).status).toBe(400);
    expect((await talk(req('/api/hologram/talk', { choom: 'Eve', text: 'hi' }, { 'x-forwarded-for': '8.8.4.4' }))).status).toBe(403);
  });

  test('"OK Chooms": the Signal room when one is set, else the room he last spoke in', async () => {
    const spoken = await prisma.groupRoom.create({ data: { title: 'Holoville' } });
    await prisma.groupMessage.create({ data: { roomId: spoken.id, role: 'user', authorName: 'Donny', content: 'evening all' } });
    const signal = await prisma.groupRoom.create({ data: { title: 'Signal room' } });

    mockReadFile.mockImplementation((p: unknown) => (String(p).endsWith('bridge-config.json') ? Promise.reject(new Error('none')) : undefined));
    expect(await (await talk(req('/api/hologram/talk', { room: true, text: 'hi', dryRun: true }))).json())
      .toEqual({ ok: true, dryRun: true, roomId: spoken.id, room: 'Holoville' });

    mockReadFile.mockImplementation((p: unknown) => (String(p).endsWith('bridge-config.json')
      ? Promise.resolve(JSON.stringify({ defaultGroupRoomId: signal.id })) : undefined));
    expect(await (await talk(req('/api/hologram/talk', { room: true, text: 'hi', dryRun: true }))).json())
      .toEqual({ ok: true, dryRun: true, roomId: signal.id, room: 'Signal room' });

    const res = await talk(req('/api/hologram/talk', { room: true, text: 'hi everyone' }));
    expect(await res.json()).toEqual({ ok: true, roomId: signal.id, room: 'Signal room' });
    expect(calls.find((c) => c.url.endsWith('/api/group-chat'))!.body).toMatchObject({ roomId: signal.id, message: 'hi everyone' });
  });
});
