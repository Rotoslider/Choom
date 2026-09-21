/**
 * Regression, 2026-09-21: Aloy was told twice to CREATE a new room for Eve and
 * Genesis. talk_with_sisters without `room` reuses the room for that exact set
 * of sisters, and the unknown-room error told her to "drop room to start a
 * fresh one" — so she landed in the 456-message room, believed it was new, and
 * renamed it. `new_room` makes creating a room an explicit, honest operation.
 *
 * Runs the real handler against the scratch SQLite database.
 */
import type { ToolCall } from '@/lib/types';
import type { SkillHandlerContext } from '@/lib/skill-handler';

jest.mock('@/lib/db', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prisma } = require('./helpers/scratch-db');
  return { __esModule: true, default: prisma, prisma };
});
jest.mock('undici', () => ({
  Agent: class {},
  fetch: jest.fn(async () => ({
    status: 200, ok: true,
    body: { getReader: () => { let done = false; return { read: async () => done ? { done: true, value: undefined } : (done = true, { done: false, value: new TextEncoder().encode(`data: ${JSON.stringify({ type: 'speaker_done', speakerName: 'Eve', content: 'hi' })}\n\n`) }) }; } },
  })),
}));

// The handler creates the new room's shared folder under WORKSPACE_ROOT. Point
// that at a temp dir — the first run of this test left two empty
// choom_commons/rooms/family-time-* folders in the REAL workspace (2026-09-21).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'room-test-'));
jest.mock('@/lib/config', () => ({ ...jest.requireActual('@/lib/config'), get WORKSPACE_ROOT() { return scratchRoot; } }));

import { prisma, teardown } from './helpers/scratch-db';
import GroupChatHandler from '@/skills/core/group-chat/handler';

const handler = new GroupChatHandler();
let aloy: { id: string }; let eve: { id: string }; let genesis: { id: string }; let oldRoomId: string;
const run = (choomId: string, args: Record<string, unknown>) =>
  handler.execute({ id: 't', name: 'talk_with_sisters', arguments: args } as ToolCall, { choomId, send: jest.fn(), settings: {} } as unknown as SkillHandlerContext);
const result = (r: { result?: unknown }) => r.result as Record<string, unknown>;

beforeAll(async () => {
  const mk = (name: string) => prisma.choom.create({ data: { name } });
  aloy = await mk('Aloy'); eve = await mk('Eve'); genesis = await mk('Genesis');
  const old = await prisma.groupRoom.create({ data: { title: 'Sisters: Eve & Genesis & Aloy', projectFolder: 'choom_commons/rooms/sisters-old', autoRounds: 3,
    participants: { create: [{ choomId: genesis.id, order: 0, active: true }, { choomId: aloy.id, order: 1, active: true }, { choomId: eve.id, order: 2, active: true }] } } });
  oldRoomId = old.id;
});
afterAll(async () => { await teardown(); fs.rmSync(scratchRoot, { recursive: true, force: true }); });

describe('talk_with_sisters new_room', () => {
  test('without new_room, the same-sisters room is reused and the result says so', async () => {
    const r = await run(aloy.id, { sisters: ['Eve', 'Genesis'], message: 'hi' });
    expect(r.error).toBeUndefined();
    expect(result(r).room_id).toBe(oldRoomId);
    expect(result(r).created_new_room).toBe(false);
    expect(String(result(r).note)).toContain('Existing room reused');
  });

  test('naming a room that does not exist points at new_room, not at dropping room', async () => {
    const r = await run(aloy.id, { sisters: ['Eve', 'Genesis'], room: 'Family Time', message: 'hi' });
    expect(r.error).toMatch(/new_room: "Family Time"/);
    expect(r.error).not.toMatch(/drop the "room" parameter/);
  });

  test('new_room creates a separate room even though one with these sisters exists', async () => {
    const r = await run(aloy.id, { sisters: ['Eve', 'Genesis'], new_room: 'Family Time', message: 'Welcome to our new home!' });
    expect(r.error).toBeUndefined();
    const res = result(r);
    expect(res.created_new_room).toBe(true);
    expect(res.room_title).toBe('Family Time');
    expect(res.room_id).not.toBe(oldRoomId);
    expect(String(res.note)).toContain('BRAND-NEW room');
    const rooms = await prisma.groupRoom.findMany({ include: { participants: true } });
    expect(rooms).toHaveLength(2);
    const fresh = rooms.find(x => x.id === res.room_id)!;
    expect(fresh.participants.filter(p => p.active).map(p => p.choomId).sort()).toEqual([aloy.id, eve.id, genesis.id].sort());
    const old = rooms.find(x => x.id === oldRoomId)!;
    expect(old.title).toBe('Sisters: Eve & Genesis & Aloy');
    // The folder went to the scratch workspace, not the real one.
    expect(fs.existsSync(path.join(scratchRoot, String(fresh.projectFolder)))).toBe(true);
  });

  test('a second new_room with the same name is refused and points at room=', async () => {
    const r = await run(aloy.id, { sisters: ['Eve', 'Genesis'], new_room: 'Family Time', message: 'again' });
    expect(r.error).toMatch(/already exists/);
    expect(r.error).toMatch(/room: "Family Time"/);
    expect(await prisma.groupRoom.count()).toBe(2);
  });

  test('room and new_room together is rejected', async () => {
    const r = await run(aloy.id, { sisters: ['Eve'], room: 'Family Time', new_room: 'Other', message: 'x' });
    expect(r.error).toMatch(/not both/);
  });
});
