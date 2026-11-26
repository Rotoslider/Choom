/**
 * 2026-11-26, Aloy's "Thanksgiving Morning" room: she started it from her 1:1
 * at 06:14 and it ran its 3 rounds to 06:34. Donny turned the room's
 * auto-rounds down at 06:15, which did nothing (the cap was read once, at the
 * start), and the Stop button in /rooms only closed the page's own stream, so
 * a run a Choom started had no stop at all.
 *  - Turning auto-rounds down mid-run now ends the run sooner.
 *  - PUT { stop: roomId } ends whichever run holds the room, mid-turn.
 *
 * Runs the real /api/group-chat route against a scratch database, with speaker
 * turns stubbed.
 */
import { NextRequest } from 'next/server';

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
jest.mock('undici', () => ({ Agent: class {}, fetch: jest.fn() }));

import { prisma, teardown } from './helpers/scratch-db';
import { GET, POST, PUT } from '@/app/api/group-chat/route';

jest.setTimeout(30_000);

type TurnOpts = { speakerName: string; stopSignal?: AbortSignal };
const ids: Record<string, string> = {};
const spoke: string[] = [];
const reply = (content: string) => ({ passed: false, windingDown: false, content, imageUrl: null, imageId: null, toolCalls: [] });

async function newRoom(title: string, autoRounds: number): Promise<string> {
  const room = await prisma.groupRoom.create({
    data: {
      title,
      autoRounds,
      participants: { create: ['Aloy', 'Genesis', 'Eve'].map((name, order) => ({ choomId: ids[name], order, active: true })) },
    },
  });
  return room.id;
}

/** Aloy opens the room herself, as talk_with_sisters does; returns the stream's text. */
async function aloyOpens(roomId: string): Promise<string> {
  const res = await POST(new NextRequest('http://localhost:3000/api/group-chat', {
    method: 'POST',
    body: JSON.stringify({ roomId, message: 'Happy Thanksgiving!', initiatorChoomId: ids.Aloy, triggerSource: 'chat' }),
  }));
  return res.text();
}

const put = (body: unknown) => PUT(new Request('http://localhost:3000/api/group-chat', { method: 'PUT', body: JSON.stringify(body) }));

beforeAll(async () => {
  for (const name of ['Aloy', 'Genesis', 'Eve']) ids[name] = (await prisma.choom.create({ data: { name } })).id;
});
beforeEach(() => { spoke.length = 0; mockTurn.mockReset(); });
afterAll(teardown);

describe('auto-rounds turned down while a room is running', () => {
  test('the room as it was: round 0 and then all 3 rounds', async () => {
    const roomId = await newRoom('Untouched', 3);
    mockTurn.mockImplementation(async (o: TurnOpts) => { spoke.push(o.speakerName); return reply(`${o.speakerName} here`); });
    await aloyOpens(roomId);
    expect(spoke).toHaveLength(2 + 3 * 3); // Genesis and Eve answer her, then 3 rounds of 3
  });

  test('turned down to 1 during round 0: one more round, then it ends', async () => {
    const roomId = await newRoom('Down to 1', 3);
    mockTurn.mockImplementation(async (o: TurnOpts) => {
      spoke.push(o.speakerName);
      if (spoke.length === 1) await prisma.groupRoom.update({ where: { id: roomId }, data: { autoRounds: 1 } });
      return reply(`${o.speakerName} here`);
    });
    await aloyOpens(roomId);
    expect(spoke).toHaveLength(2 + 3);
  });

  test('turned down to 0: the run ends after the round it is in', async () => {
    const roomId = await newRoom('Down to 0', 3);
    mockTurn.mockImplementation(async (o: TurnOpts) => {
      spoke.push(o.speakerName);
      if (spoke.length === 4) await prisma.groupRoom.update({ where: { id: roomId }, data: { autoRounds: 0 } });
      return reply(`${o.speakerName} here`);
    });
    await aloyOpens(roomId);
    expect(spoke).toHaveLength(2 + 3); // round 1 was under way; it finishes, nothing after
  });

  test('turned up mid-run: the run already going keeps its length', async () => {
    const roomId = await newRoom('Up to 5', 1);
    mockTurn.mockImplementation(async (o: TurnOpts) => {
      spoke.push(o.speakerName);
      if (spoke.length === 1) await prisma.groupRoom.update({ where: { id: roomId }, data: { autoRounds: 5 } });
      return reply(`${o.speakerName} here`);
    });
    await aloyOpens(roomId);
    expect(spoke).toHaveLength(2 + 3);
  });
});

describe('Stop ends a run the page did not start', () => {
  test('mid-turn: the speaker is cut off and nobody speaks after her', async () => {
    const roomId = await newRoom('Stopped', 3);
    let sawAbort = false;
    mockTurn.mockImplementation(async (o: TurnOpts) => {
      spoke.push(o.speakerName);
      if (spoke.length === 3) {
        const res = await put({ stop: roomId });
        expect(await res.json()).toMatchObject({ stopped: true });
        sawAbort = !!o.stopSignal?.aborted;
        return { ...reply('I was saying'), error: `${o.speakerName} turn stopped: stopped from Group Rooms` };
      }
      return reply(`${o.speakerName} here`);
    });
    const stream = await aloyOpens(roomId);
    expect(sawAbort).toBe(true);
    expect(spoke).toHaveLength(3);
    expect(stream).toContain('"type":"stopped"');
    // What she had said is kept, marked as cut off.
    const last = await prisma.groupMessage.findFirst({ where: { roomId }, orderBy: { createdAt: 'desc' } });
    expect(last?.content).toMatch(/^I was saying[\s\S]*turn cut off — stopped from Group Rooms/);
    // The room is free again.
    const status = await GET(new NextRequest(`http://localhost:3000/api/group-chat?roomId=${roomId}`));
    expect(await status.json()).toMatchObject({ running: false });
  });

  test('with nothing running, stop says so and changes nothing', async () => {
    const roomId = await newRoom('Quiet', 3);
    const res = await put({ stop: roomId });
    expect(await res.json()).toMatchObject({ stopped: false, wasPaused: false });
  });

  test('pause and resume still work as before', async () => {
    const res = await put({ resume: true });
    expect(res.status).toBe(200);
    const bad = await put({});
    expect(bad.status).toBe(400);
  });
});
