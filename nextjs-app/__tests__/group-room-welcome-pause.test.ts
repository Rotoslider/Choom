/**
 * 2026-10-15: a room pauses for Donny's welcome back and picks up again once he's
 * done talking with whoever welcomed him. Genesis welcomed him in the middle of a
 * room her heartbeat had opened, and the chime for his answer waited 3½ minutes
 * for two more room turns.
 *
 * Runs the real /api/group-chat route against a scratch database. Speaker turns
 * are stubbed, and the resume's own call back into the route is caught.
 */
import { NextRequest } from 'next/server';
import { readFileSync } from 'fs';
import path from 'path';

jest.mock('@/lib/db', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prisma } = require('./helpers/scratch-db');
  return { __esModule: true, default: prisma, prisma };
});
jest.mock('@/lib/group-model-config', () => ({ getRoomCreatorModel: () => null }));
jest.mock('@/lib/owner', () => ({ getOwnerIdentity: () => ({ name: 'Donny' }) }));
const mockTurn = jest.fn();
jest.mock('@/lib/group-chat-runner', () => ({
  runSpeakerTurn: (opts: unknown) => mockTurn(opts),
  detectConvergence: () => false,
  DIVERGENCE_DIRECTIVES: ['say something new'],
}));
const mockFetch = jest.fn(async (..._args: unknown[]) => ({
  body: { getReader: () => ({ read: async () => ({ done: true }) }) },
}));
jest.mock('undici', () => ({ Agent: class {}, fetch: (...args: unknown[]) => mockFetch(...args) }));

import { prisma, teardown } from './helpers/scratch-db';
import { POST, PUT } from '@/app/api/group-chat/route';

jest.setTimeout(30_000);

const ids: Record<string, string> = {};
const spoke: string[] = [];

const reply = (content: string) => ({ passed: false, windingDown: false, content, imageUrl: null, imageId: null, toolCalls: [] });
const put = async (body: Record<string, unknown>) =>
  (await PUT(new Request('http://localhost:3000/api/group-chat', { method: 'PUT', body: JSON.stringify(body) }))).json();

async function runRoom(body: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  const res = await POST(new NextRequest('http://localhost:3000/api/group-chat', { method: 'POST', body: JSON.stringify(body) }));
  const text = await res.text(); // the whole run
  return text.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
}

async function newRoom(title: string): Promise<string> {
  const room = await prisma.groupRoom.create({
    data: {
      title,
      autoRounds: 3,
      participants: { create: ['Genesis', 'Aloy', 'Eve'].map((name, order) => ({ choomId: ids[name], order, active: true })) },
    },
  });
  return room.id;
}

beforeAll(async () => {
  for (const name of ['Genesis', 'Aloy', 'Eve']) ids[name] = (await prisma.choom.create({ data: { name } })).id;
});
beforeEach(() => {
  spoke.length = 0;
  mockTurn.mockReset();
  mockFetch.mockClear();
});
afterAll(teardown);

describe('a room makes way for his welcome back', () => {
  test('it stops before the next speaker and picks up with her when he is done', async () => {
    const roomId = await newRoom('Gate camera');
    mockTurn.mockImplementation(async (o: { speakerName: string }) => {
      spoke.push(o.speakerName);
      if (spoke.length === 1) expect(await put({ pause: true })).toEqual({ pausing: [{ roomId, speaker: 'Aloy' }] });
      return reply(`${o.speakerName} here`);
    });
    const events = await runRoom({
      roomId, message: 'Who wants to look at the gate camera?', initiatorChoomId: ids.Genesis,
      rounds: 2, triggerSource: 'heartbeat', settings: { llm: 'local' },
    });
    expect(spoke).toEqual(['Aloy']);
    expect(events.find(e => e.type === 'paused')).toEqual({ type: 'paused', nextSpeakerName: 'Eve' });

    expect(await put({ resume: true })).toEqual({ resumed: [roomId], carriedOn: [] });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, { body: string }];
    expect(url).toMatch(/\/api\/group-chat$/);
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      roomId, continue: true, rounds: 3, nextSpeakerId: ids.Eve, settings: { llm: 'local' }, triggerSource: 'resume',
    });

    // The run the route started for itself: Eve first, then on around the room.
    spoke.length = 0;
    mockTurn.mockImplementation(async (o: { speakerName: string }) => { spoke.push(o.speakerName); return reply('back to it'); });
    await runRoom({ ...body, rounds: 1 });
    expect(spoke).toEqual(['Eve', 'Genesis', 'Aloy']);
    expect(await put({ resume: true })).toEqual({ resumed: [], carriedOn: [] });
  });

  test('done before the next speaker: the room just carries on', async () => {
    const roomId = await newRoom('Rock ring');
    mockTurn.mockImplementation(async (o: { speakerName: string }) => {
      spoke.push(o.speakerName);
      if (spoke.length === 1) {
        await put({ pause: true });
        expect(await put({ resume: true })).toEqual({ resumed: [], carriedOn: [roomId] });
      }
      return reply('still here');
    });
    const events = await runRoom({ roomId, message: 'hi', initiatorChoomId: ids.Genesis, rounds: 1, triggerSource: 'heartbeat' });
    expect(events.some(e => e.type === 'paused')).toBe(false);
    expect(spoke.slice(0, 2)).toEqual(['Aloy', 'Eve']);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('his own message to a paused room takes its place', async () => {
    const roomId = await newRoom('Burn area');
    mockTurn.mockImplementation(async (o: { speakerName: string }) => {
      spoke.push(o.speakerName);
      if (spoke.length === 1) await put({ pause: true });
      return reply('ok');
    });
    await runRoom({ roomId, message: 'hi', initiatorChoomId: ids.Genesis, rounds: 1, triggerSource: 'heartbeat' });
    mockTurn.mockImplementation(async () => reply('hi Donny'));
    await runRoom({ roomId, message: 'I found nothing by the west fence', rounds: 0 });
    expect(await put({ resume: true })).toEqual({ resumed: [], carriedOn: [] });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('nothing running, nothing to pause; pause or resume is required', async () => {
    expect(await put({ pause: true })).toEqual({ pausing: [] });
    const res = await PUT(new Request('http://localhost:3000/api/group-chat', { method: 'PUT', body: '{}' }));
    expect(res.status).toBe(400);
  });

  test('the welcome pauses rooms as she welcomes him, and { done } picks them up', () => {
    const src = readFileSync(path.join(__dirname, '..', 'app', 'api', 'hologram', 'welcome', 'route.ts'), 'utf-8');
    expect(src).toContain("if (body.done === true) return NextResponse.json({ ok: true, ...(await rooms(request, 'resume')) });");
    expect(src.indexOf("await rooms(request, 'pause')")).toBeLessThan(src.indexOf("fetch(new URL('/api/chat'"));
  });
});

// 2026-10-16: nothing waits forever for the { resume }. The hologram only says it's done after a
// welcome that went out; a hologram restart, or a welcome that failed, left rooms paused.
describe('a pause that nobody ends', () => {
  const FIFTEEN_MIN = 15 * 60 * 1000;
  afterEach(() => jest.restoreAllMocks());

  test('a paused room picks itself up after 15 minutes with no word from the hologram', async () => {
    const roomId = await newRoom('Water tank');
    const timers = jest.spyOn(global, 'setTimeout');
    mockTurn.mockImplementation(async (o: { speakerName: string }) => {
      spoke.push(o.speakerName);
      if (spoke.length === 1) await put({ pause: true });
      return reply('ok');
    });
    await runRoom({ roomId, message: 'hi', initiatorChoomId: ids.Genesis, rounds: 2, triggerSource: 'heartbeat' });
    const pickUp = timers.mock.calls.find(([, ms]) => ms === FIFTEEN_MIN)?.[0] as (() => void) | undefined;
    expect(pickUp).toBeDefined();
    expect(mockFetch).not.toHaveBeenCalled();
    pickUp!();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse((mockFetch.mock.calls[0] as [string, { body: string }])[1].body))
      .toMatchObject({ roomId, continue: true, nextSpeakerId: ids.Eve, triggerSource: 'resume' });
    expect(await put({ resume: true })).toEqual({ resumed: [], carriedOn: [] }); // nothing left paused
  });

  test('resumed in time: the 15-minute pick-up does nothing', async () => {
    const roomId = await newRoom('Solar panels');
    const timers = jest.spyOn(global, 'setTimeout');
    mockTurn.mockImplementation(async (o: { speakerName: string }) => {
      spoke.push(o.speakerName);
      if (spoke.length === 1) await put({ pause: true });
      return reply('ok');
    });
    await runRoom({ roomId, message: 'hi', initiatorChoomId: ids.Genesis, rounds: 2, triggerSource: 'heartbeat' });
    expect(await put({ resume: true })).toEqual({ resumed: [roomId], carriedOn: [] });
    (timers.mock.calls.find(([, ms]) => ms === FIFTEEN_MIN)![0] as () => void)();
    expect(mockFetch).toHaveBeenCalledTimes(1); // the resume's, not a second one
  });

  test('a pause asked for more than 15 minutes before the next speaker is dropped', async () => {
    const roomId = await newRoom('Well pump');
    const realNow = Date.now.bind(Date);
    let ahead = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + ahead);
    mockTurn.mockImplementation(async (o: { speakerName: string }) => {
      spoke.push(o.speakerName);
      if (spoke.length === 1) {
        expect(await put({ pause: true })).toEqual({ pausing: [{ roomId, speaker: 'Aloy' }] });
        ahead = FIFTEEN_MIN + 1000;
        expect(await put({ resume: true })).toEqual({ resumed: [], carriedOn: [] }); // too old to count
        ahead = 0;
        expect(await put({ pause: true })).toEqual({ pausing: [{ roomId, speaker: 'Aloy' }] });
        ahead = FIFTEEN_MIN + 1000; // and this one has gone stale by the time Eve is next
      }
      return reply('ok');
    });
    const events = await runRoom({ roomId, message: 'hi', initiatorChoomId: ids.Genesis, rounds: 1, triggerSource: 'heartbeat' });
    expect(events.some(e => e.type === 'paused')).toBe(false);
    expect(spoke.slice(0, 2)).toEqual(['Aloy', 'Eve']);
  });
});
