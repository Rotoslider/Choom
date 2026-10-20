/**
 * 2026-10-20: the room's auto-rounds (the owner's setting in /rooms) caps a
 * Choom-started run too. Before, a sister's talk_with_sisters run used its own
 * rounds (default 3, up to 10), and changing the room's number only held for
 * his own messages.
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
import { POST } from '@/app/api/group-chat/route';

jest.setTimeout(30_000);

const ids: Record<string, string> = {};
const spoke: string[] = [];
const reply = (content: string) => ({ passed: false, windingDown: false, content, imageUrl: null, imageId: null, toolCalls: [] });

async function runRoom(body: Record<string, unknown>): Promise<void> {
  const res = await POST(new NextRequest('http://localhost:3000/api/group-chat', { method: 'POST', body: JSON.stringify(body) }));
  await res.text(); // the whole run
}

async function newRoom(title: string, autoRounds: number): Promise<string> {
  const room = await prisma.groupRoom.create({
    data: {
      title,
      autoRounds,
      participants: { create: ['Genesis', 'Aloy', 'Eve'].map((name, order) => ({ choomId: ids[name], order, active: true })) },
    },
  });
  return room.id;
}

// Turns a run takes in a room set to `autoRounds`, Genesis opening it and asking for `rounds`.
async function turns(autoRounds: number, rounds?: number): Promise<number> {
  const roomId = await newRoom(`Room ${autoRounds}/${rounds}`, autoRounds);
  spoke.length = 0;
  await runRoom({ roomId, message: 'hi', initiatorChoomId: ids.Genesis, triggerSource: 'heartbeat', ...(rounds !== undefined && { rounds }) });
  return spoke.length;
}

beforeAll(async () => {
  for (const name of ['Genesis', 'Aloy', 'Eve']) ids[name] = (await prisma.choom.create({ data: { name } })).id;
  mockTurn.mockImplementation(async (o: { speakerName: string }) => { spoke.push(o.speakerName); return reply(`${o.speakerName} here`); });
});
afterAll(teardown);

describe("the room's auto-rounds caps a sister's own run", () => {
  test('asking for more than the room allows gets what the room allows', async () => {
    expect(await turns(1, 5)).toBe(await turns(1, 1));
    expect(await turns(3, 10)).toBe(await turns(3, 3));
  });

  test('asking for fewer is kept', async () => {
    expect(await turns(3, 1)).toBe(await turns(1, 1));
    expect(await turns(3, 1)).toBeLessThan(await turns(3, 3));
  });

  test("without rounds, the room's setting is the default", async () => {
    expect(await turns(3)).toBe(await turns(3, 3));
    expect(await turns(1)).toBe(await turns(1, 1));
  });

  test('a room set to 0 still gives her one round back', async () => {
    expect(await turns(0, 3)).toBe(await turns(1, 1));
  });
});
