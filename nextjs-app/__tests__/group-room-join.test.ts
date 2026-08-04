/**
 * Test: a Choom can add HERSELF to an existing group room.
 *
 * Regression: room lookup in talk_with_sisters was scoped to rooms the caller
 * was already an active participant of, and list_my_rooms only listed her own.
 * A Choom asked to join an existing room therefore saw an empty room list, no
 * way to discover the room, and no tool that could seat her — she concluded she
 * was locked out and asked the owner to add her.
 *
 * Runs the real GroupChatHandler against a real (scratch) SQLite database
 * seeded with the exact shape of that incident: Optic in no rooms, a
 * "D1_Robot_project" room owned by Genesis + Eve.
 */
import type { ToolCall } from '@/lib/types';
import type { SkillHandlerContext } from '@/lib/skill-handler';

// The handler talks to the scratch database instead of dev.db.
jest.mock('@/lib/db', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prisma } = require('./helpers/scratch-db');
  return { __esModule: true, default: prisma, prisma };
});

// The orchestrator call is HTTP; stub it so talk_with_sisters exercises room
// resolution + seating without a live server. One sibling "reply" comes back.
jest.mock('undici', () => ({
  Agent: class {},
  fetch: jest.fn(async () => ({
    status: 200,
    ok: true,
    body: {
      getReader: () => {
        const chunks = [
          `data: ${JSON.stringify({ type: 'speaker_done', speakerName: 'Eve', content: 'hey' })}\n\n`,
        ];
        let i = 0;
        return {
          read: async () =>
            i < chunks.length
              ? { done: false, value: new TextEncoder().encode(chunks[i++]) }
              : { done: true, value: undefined },
        };
      },
    },
  })),
}));

import { prisma, teardown } from './helpers/scratch-db';
import GroupChatHandler from '@/skills/core/group-chat/handler';

const ROOM_TITLE = 'D1_Robot_project';
const ROOM_FOLDER = 'choom_commons/rooms/d1-robot-project-9bnsb5';

let optic: { id: string };
let genesis: { id: string };
let eve: { id: string };
let roomId: string;
const handler = new GroupChatHandler();

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: `t-${name}`, name, arguments: args } as ToolCall;
}

function ctxFor(choomId: string): SkillHandlerContext {
  return { choomId, send: jest.fn(), settings: {} } as unknown as SkillHandlerContext;
}

const run = (choomId: string, name: string, args: Record<string, unknown> = {}) =>
  handler.execute(call(name, args), ctxFor(choomId));

// Fresh membership before each test: Optic out, Genesis + Eve in.
async function resetRoom() {
  await prisma.groupParticipant.deleteMany({ where: { roomId } });
  await prisma.groupParticipant.createMany({
    data: [
      { roomId, choomId: genesis.id, order: 0, active: true },
      { roomId, choomId: eve.id, order: 1, active: true },
    ],
  });
}

beforeAll(async () => {
  const mk = (name: string) => prisma.choom.create({ data: { name } });
  optic = await mk('Optic');
  genesis = await mk('Genesis');
  eve = await mk('Eve');
  const room = await prisma.groupRoom.create({
    data: { title: ROOM_TITLE, projectFolder: ROOM_FOLDER, autoRounds: 3 },
  });
  roomId = room.id;
  await prisma.groupMessage.create({
    data: { roomId, role: 'assistant', authorChoomId: genesis.id, authorName: 'Genesis', content: 'quadruped notes' },
  });
});

beforeEach(resetRoom);

afterAll(teardown);

const activeMembers = () =>
  prisma.groupParticipant.findMany({ where: { roomId, active: true }, orderBy: { order: 'asc' } });

describe('list_my_rooms discovery', () => {
  test('a Choom in no rooms still sees the rooms she can join', async () => {
    const res = await run(optic.id, 'list_my_rooms');
    const r = res.result as { rooms: unknown[]; other_rooms: Array<{ name: string; members: string[] }>; note: string };

    expect(r.rooms).toHaveLength(0);
    expect(r.other_rooms).toHaveLength(1);
    expect(r.other_rooms[0].name).toBe(ROOM_TITLE);
    expect(r.other_rooms[0].members.sort()).toEqual(['Eve', 'Genesis']);
    // The dead-end this regression produced: an empty list that reads as "locked out".
    expect(r.note).toMatch(/join_room/);
    expect(r.note).not.toMatch(/only.*owner|ask.*to add you/i);
  });

  test("a member sees the room under `rooms`, not `other_rooms`", async () => {
    const res = await run(genesis.id, 'list_my_rooms');
    const r = res.result as { rooms: Array<{ name: string; messages: number }>; other_rooms: unknown[] };
    expect(r.rooms.map(x => x.name)).toEqual([ROOM_TITLE]);
    expect(r.rooms[0].messages).toBe(1);
    expect(r.other_rooms).toHaveLength(0);
  });
});

describe('join_room', () => {
  test('seats a Choom in a room she has never been in', async () => {
    const res = await run(optic.id, 'join_room', { room: ROOM_TITLE });
    expect(res.error).toBeUndefined();
    expect((res.result as { joined: boolean }).joined).toBe(true);

    const members = await activeMembers();
    expect(members.map(m => m.choomId)).toContain(optic.id);
    // Seated after the existing members, so the room-creator seat is untouched.
    expect(members[0].choomId).toBe(genesis.id);
  });

  test('matches on the shared-folder slug the owner hands out', async () => {
    const res = await run(optic.id, 'join_room', { room: 'd1-robot-project-9bnsb5' });
    expect(res.error).toBeUndefined();
    expect((res.result as { room: string }).room).toBe(ROOM_TITLE);
    expect((await activeMembers()).map(m => m.choomId)).toContain(optic.id);
  });

  test('is idempotent — a second join adds no duplicate seat', async () => {
    await run(optic.id, 'join_room', { room: ROOM_TITLE });
    const res = await run(optic.id, 'join_room', { room: ROOM_TITLE });
    expect(res.error).toBeUndefined();
    expect((res.result as { joined: boolean; already_in: boolean }).joined).toBe(false);
    expect((res.result as { already_in: boolean }).already_in).toBe(true);
    expect((await prisma.groupParticipant.findMany({ where: { roomId, choomId: optic.id } }))).toHaveLength(1);
  });

  test('an unknown room name errors and lists what does exist', async () => {
    const res = await run(optic.id, 'join_room', { room: 'the Tune Lounge' });
    expect(res.error).toContain(ROOM_TITLE);
    expect((await activeMembers()).map(m => m.choomId)).not.toContain(optic.id);
  });

  test('rejoining after leave_room reactivates the original seat', async () => {
    await run(optic.id, 'join_room', { room: ROOM_TITLE });
    const seatBefore = (await prisma.groupParticipant.findFirst({ where: { roomId, choomId: optic.id } }))!;

    const left = await run(optic.id, 'leave_room', { room: ROOM_TITLE });
    expect(left.error).toBeUndefined();
    // The old note told her she could not put herself back.
    expect((left.result as { note: string }).note).toMatch(/join_room/);
    expect((await activeMembers()).map(m => m.choomId)).not.toContain(optic.id);

    await run(optic.id, 'join_room', { room: ROOM_TITLE });
    const seatAfter = (await prisma.groupParticipant.findFirst({ where: { roomId, choomId: optic.id } }))!;
    expect(seatAfter.id).toBe(seatBefore.id);
    expect(seatAfter.active).toBe(true);
  });
});

describe('talk_with_sisters into a room the caller is not in', () => {
  test('joins her and runs the conversation (the reported catch-22)', async () => {
    const res = await run(optic.id, 'talk_with_sisters', {
      room: ROOM_TITLE,
      sisters: ['Genesis', 'Eve'],
      message: 'jumping in on the quadruped',
    });
    expect(res.error).toBeUndefined();
    const r = res.result as { joined: boolean; room_id: string; note: string };
    expect(r.joined).toBe(true);
    expect(r.room_id).toBe(roomId);
    expect(r.note).toMatch(/JOINED/);
    expect((await activeMembers()).map(m => m.choomId)).toContain(optic.id);
  });

  test('`sisters` is optional when a room is named — its members are the sisters', async () => {
    const res = await run(optic.id, 'talk_with_sisters', {
      room: ROOM_TITLE,
      message: 'jumping in',
    });
    expect(res.error).toBeUndefined();
    const r = res.result as { joined: boolean; sisters: string[] };
    expect(r.joined).toBe(true);
    expect(r.sisters.sort()).toEqual(['Eve', 'Genesis']);
  });

  test('resolves by folder slug too', async () => {
    const res = await run(optic.id, 'talk_with_sisters', {
      room: 'd1-robot-project-9bnsb5',
      message: 'jumping in',
    });
    expect(res.error).toBeUndefined();
    expect((res.result as { room_id: string }).room_id).toBe(roomId);
  });

  test('a genuinely unknown room still errors instead of silently forking a new one', async () => {
    const before = await prisma.groupRoom.count();
    const res = await run(optic.id, 'talk_with_sisters', {
      room: 'somewhere that does not exist',
      sisters: ['Eve'],
      message: 'hello',
    });
    expect(res.error).toBeTruthy();
    expect(await prisma.groupRoom.count()).toBe(before);
  });

  test('joining herself AND pulling in a sister gives each a distinct seat', async () => {
    // Aloy is in no room; Optic joins and brings her along in one call.
    const aloy = await prisma.choom.create({ data: { name: 'Aloy' } });
    const res = await run(optic.id, 'talk_with_sisters', {
      room: ROOM_TITLE,
      sisters: ['Aloy'],
      message: 'bringing Aloy in',
    });
    expect(res.error).toBeUndefined();
    expect((res.result as { joined: boolean; added: string[] }).joined).toBe(true);
    expect((res.result as { added: string[] }).added).toEqual(['Aloy']);

    const orders = (await activeMembers()).map(m => m.order);
    expect(new Set(orders).size).toBe(orders.length); // no two Chooms share a seat
    // The room-creator seat (index 0, which pins the creator model) is untouched.
    expect((await activeMembers())[0].choomId).toBe(genesis.id);
    await prisma.choom.delete({ where: { id: aloy.id } });
  });

  test('an existing member is not reported as newly joined', async () => {
    const res = await run(genesis.id, 'talk_with_sisters', {
      room: ROOM_TITLE,
      message: 'continuing',
    });
    expect((res.result as { joined: boolean }).joined).toBe(false);
  });

  test('still demands `sisters` when no room is named (unchanged guard)', async () => {
    const res = await run(optic.id, 'talk_with_sisters', { message: 'hello?' });
    expect(res.error).toMatch(/"sisters" parameter is required/);
  });
});
