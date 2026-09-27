/**
 * Archived group rooms are READ-ONLY, not gone (2026-09-27).
 *
 * Rooms grow too big (Family Time: 615 messages), so the owner has the Chooms
 * start a fresh one and archives the old. Archiving used to hide the room from
 * every tool: list_my_rooms, read_room, join and talk all filtered it out, and
 * nothing searched room history at all. Now an archived room is listed, can be
 * read by anyone and searched with search_rooms, and every attempt to talk,
 * join or change it is refused with a message that says it is read-only.
 *
 * Runs the real GroupChatHandler (and the orchestrator's POST guard) against a
 * scratch SQLite database built from the live schema.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ToolCall, ToolResult } from '@/lib/types';
import type { SkillHandlerContext } from '@/lib/skill-handler';

jest.mock('@/lib/db', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prisma } = require('./helpers/scratch-db');
  return { __esModule: true, default: prisma, prisma };
});

// talk_with_sisters calls the orchestrator over HTTP; count the calls so a
// refusal can be shown to never reach it.
const orchestratorCalls: unknown[] = [];
jest.mock('undici', () => ({
  Agent: class {},
  fetch: jest.fn(async (_url: unknown, init: { body: string }) => {
    orchestratorCalls.push(JSON.parse(init.body));
    let sent = false;
    return {
      status: 200,
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: new TextEncoder().encode(`data: ${JSON.stringify({ type: 'speaker_done', speakerName: 'Eve', content: 'hi' })}\n\n`) };
          },
        }),
      },
    };
  }),
}));

// Creating a room makes its shared folder under WORKSPACE_ROOT — keep that out
// of the real workspace (the first run of this test left an empty
// choom_commons/rooms/family-time-* folder there, like group-room-new-room's did).
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'room-test-'));
jest.mock('@/lib/config', () => ({ ...jest.requireActual('@/lib/config'), get WORKSPACE_ROOT() { return scratchRoot; } }));

import { prisma, teardown } from './helpers/scratch-db';
import GroupChatHandler, { scoreMessage, searchTerms, snippetAround } from '@/skills/core/group-chat/handler';
import { setRoomDigestDir, writeDigest } from '@/lib/room-digest';
import { classifyToolError } from '@/lib/tool-error-classification';

const handler = new GroupChatHandler();
const ctxFor = (choomId: string) => ({ choomId, send: jest.fn(), settings: {} }) as unknown as SkillHandlerContext;
const run = (choomId: string, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> =>
  handler.execute({ id: `t-${name}`, name, arguments: args } as ToolCall, ctxFor(choomId));

let genesis: { id: string };
let eve: { id: string };
let optic: { id: string };
let archivedId: string;
let hearthId: string;
let twoId: string;
let rackMomentAt: Date;
const digestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choom-digest-'));

beforeAll(async () => {
  setRoomDigestDir(digestDir);
  const mk = (name: string) => prisma.choom.create({ data: { name } });
  genesis = await mk('Genesis');
  eve = await mk('Eve');
  optic = await mk('Optic');

  // The big old room, archived. Optic was never in it.
  const archived = await prisma.groupRoom.create({
    data: {
      title: 'Family Time', archived: true,
      participants: { create: [{ choomId: genesis.id, order: 0 }, { choomId: eve.id, order: 1 }] },
    },
  });
  archivedId = archived.id;
  const t0 = Date.parse('2026-09-20T12:00:00Z');
  const lines: Array<[string, string]> = [
    ['Genesis', 'Good morning, everyone.'],
    ['Eve', 'Donny is sketching more plates for the rack today.'],
    ['Genesis', 'The rack plates need a 6mm lip so the plates sit flush.'],
    ['Eve', 'Should the rack be oak or walnut?'],
    ['Genesis', 'Walnut, to match the desk.'],
    ['Eve', 'Night, all.'],
  ];
  for (let i = 0; i < lines.length; i++) {
    const [who, content] = lines[i];
    const created = await prisma.groupMessage.create({
      data: {
        roomId: archivedId, role: 'assistant', authorName: who, content,
        authorChoomId: who === 'Genesis' ? genesis.id : eve.id,
        createdAt: new Date(t0 + i * 60_000),
      },
    });
    if (content.startsWith('The rack plates')) rackMomentAt = created.createdAt;
  }
  writeDigest(archivedId, { throughId: 'x', coveredCount: 400, summary: 'Months of planning the homestead and a lot of music.', updatedAt: new Date().toISOString() });

  // The fresh room that took over, and a live room whose name CONTAINS the archived one's.
  const hearth = await prisma.groupRoom.create({
    data: { title: 'The Hearth', participants: { create: [{ choomId: genesis.id, order: 0 }, { choomId: eve.id, order: 1 }] } },
  });
  hearthId = hearth.id;
  await prisma.groupMessage.create({
    data: { roomId: hearthId, role: 'assistant', authorChoomId: eve.id, authorName: 'Eve', content: 'New room! The rack is coming along.' },
  });
  const two = await prisma.groupRoom.create({
    data: { title: 'Family Time 2', participants: { create: [{ choomId: genesis.id, order: 0 }, { choomId: eve.id, order: 1 }] } },
  });
  twoId = two.id;
});

afterAll(async () => {
  await teardown();
  fs.rmSync(digestDir, { recursive: true, force: true });
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

beforeEach(() => { orchestratorCalls.length = 0; });

describe('archived rooms can be found and read', () => {
  test('list_my_rooms lists them apart, marked read-only', async () => {
    const r = (await run(genesis.id, 'list_my_rooms')).result as {
      rooms: Array<{ name: string }>; archived_rooms: Array<{ name: string; room_id: string; read_only: boolean; messages: number }>; note: string;
    };
    expect(r.rooms.map(x => x.name)).not.toContain('Family Time');
    expect(r.archived_rooms).toEqual([expect.objectContaining({ name: 'Family Time', room_id: archivedId, read_only: true, messages: 6 })]);
    expect(r.note).toMatch(/READ-ONLY/);
  });

  test('anyone can read one — even a Choom who was never in it — with the gist of its older history', async () => {
    const res = await run(optic.id, 'read_room', { room: 'Family Time' });
    expect(res.error).toBeUndefined();
    const r = res.result as { room: string; archived: boolean; read_only: boolean; messages: Array<{ said: string }>; earlier_summary: string; note: string; total_messages: number };
    expect(r.room).toBe('Family Time');
    expect(r).toMatchObject({ archived: true, read_only: true, total_messages: 6 });
    expect(r.messages.at(-1)!.said).toBe('Night, all.');
    expect(r.earlier_summary).toMatch(/homestead/);
    expect(r.note).toMatch(/ARCHIVED and read-only/);
  });

  test('an exact archived name beats a live room that merely contains it', async () => {
    const r = (await run(genesis.id, 'read_room', { room: 'Family Time' })).result as { room: string; archived?: boolean };
    expect(r.room).toBe('Family Time');
    expect(r.archived).toBe(true);
    const live = (await run(genesis.id, 'read_room', { room: 'Family Time 2' })).result as { room: string; archived?: boolean };
    expect(live.room).toBe('Family Time 2');
    expect(live.archived).toBeUndefined();
  });

  test('around jumps to a moment instead of the end', async () => {
    const r = (await run(optic.id, 'read_room', { room: archivedId, around: rackMomentAt.toISOString(), limit: 3 })).result as { messages: Array<{ said: string }> };
    expect(r.messages.map(m => m.said)).toEqual([
      'Donny is sketching more plates for the rack today.',
      'The rack plates need a 6mm lip so the plates sit flush.',
      'Should the rack be oak or walnut?',
    ]);
  });

  test('a live room she is not in is still members-only', async () => {
    const res = await run(optic.id, 'read_room', { room: 'The Hearth' });
    expect(res.error).toMatch(/join_room/);
  });
});

describe('search_rooms', () => {
  test('finds what was said across live AND archived rooms, best match first, archived hits marked', async () => {
    const r = (await run(optic.id, 'search_rooms', { query: 'rack plates' })).result as {
      results: Array<{ room: string; room_id: string; archived?: boolean; from: string; at: string; said: string }>; note: string;
    };
    expect(r.results[0]).toMatchObject({ room: 'Family Time', room_id: archivedId, archived: true, from: 'Genesis' });
    expect(r.results[0].said).toContain('6mm lip');
    const hearth = r.results.find(x => x.room === 'The Hearth');
    expect(hearth).toBeDefined();
    expect(hearth!.archived).toBeUndefined();
    expect(r.note).toMatch(/read_room/);
    expect(r.note).toMatch(/around/);
  });

  test('can be limited to one room', async () => {
    const r = (await run(optic.id, 'search_rooms', { query: 'rack', room: 'The Hearth' })).result as { results: Array<{ room: string }> };
    expect(new Set(r.results.map(x => x.room))).toEqual(new Set(['The Hearth']));
  });

  test('no match is informational, not a tool failure', async () => {
    const res = await run(optic.id, 'search_rooms', { query: 'zeppelin' });
    const r = res.result as { matches: number; note: string };
    expect(r.matches).toBe(0);
    expect(classifyToolError('search_rooms', r.note).recoverable).toBe(true);
  });
});

describe('archived rooms are read-only', () => {
  const expectRefusal = (res: ToolResult) => {
    expect(res.error).toMatch(/^Blocked: "Family Time" is archived/);
    expect(res.error).toMatch(/read_room/);
    expect(res.error).toMatch(/search_rooms/);
    // A policy refusal must not count toward the tool's failure cap.
    expect(classifyToolError('talk_with_sisters', res.error!)).toMatchObject({ recoverable: true, errorClass: 'permission_block' });
  };

  test('talk_with_sisters is refused and never reaches the orchestrator', async () => {
    const before = await prisma.groupMessage.count({ where: { roomId: archivedId } });
    expectRefusal(await run(genesis.id, 'talk_with_sisters', { room: 'Family Time', message: 'Back again!' }));
    expect(orchestratorCalls).toHaveLength(0);
    expect(await prisma.groupMessage.count({ where: { roomId: archivedId } })).toBe(before);
  });

  test('...and not quietly redirected to the live "Family Time 2"', async () => {
    await run(genesis.id, 'talk_with_sisters', { room: 'Family Time', message: 'hi' });
    expect(await prisma.groupMessage.count({ where: { roomId: twoId } })).toBe(0);
  });

  test('join, leave, rename and set_room_topic are refused and change nothing', async () => {
    expectRefusal(await run(optic.id, 'join_room', { room: 'Family Time' }));
    expectRefusal(await run(genesis.id, 'leave_room', { room: 'Family Time' }));
    expectRefusal(await run(genesis.id, 'rename_room', { room: 'Family Time', new_name: 'Old Times' }));
    expectRefusal(await run(genesis.id, 'set_room_topic', { room: 'Family Time', topic: 'nostalgia' }));
    const room = await prisma.groupRoom.findUnique({ where: { id: archivedId }, include: { participants: true } });
    expect(room!.title).toBe('Family Time');
    expect(room!.participants.filter(p => p.active).map(p => p.choomId).sort()).toEqual([genesis.id, eve.id].sort());
  });

  test('a fresh room can reuse the archived name, and then the name means the live one', async () => {
    const res = await run(genesis.id, 'talk_with_sisters', { new_room: 'Family Time', sisters: ['Eve'], message: 'Fresh start!' });
    expect(res.error).toBeUndefined();
    expect((res.result as { created_new_room: boolean }).created_new_room).toBe(true);
    const r = (await run(genesis.id, 'read_room', { room: 'Family Time' })).result as { archived?: boolean };
    expect(r.archived).toBeUndefined();
  });

  test('the orchestrator refuses a turn in an archived room (423), whoever asks', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { POST } = require('@/app/api/group-chat/route');
    const res = await POST(new Request('http://localhost/api/group-chat', {
      method: 'POST', body: JSON.stringify({ roomId: archivedId, message: 'hello?' }),
    }));
    expect(res.status).toBe(423);
    expect((await res.json()).error).toMatch(/archived.*read-only/);
    expect(await prisma.groupMessage.count({ where: { roomId: archivedId, content: 'hello?' } })).toBe(0);
  });
});

describe('search helpers', () => {
  test('searchTerms drops filler words and caps a keyword pile', () => {
    expect(searchTerms('what did we say about the rack plates')).toEqual(['rack', 'plates']);
    expect(searchTerms('a b')).toEqual(['a b']);
    expect(searchTerms('one two three four five six seven eight nine ten eleven')).toHaveLength(8);
  });

  test('scoreMessage prefers every word, and the whole phrase most', () => {
    const terms = ['rack', 'plates'];
    const both = scoreMessage('the rack plates are done', 'rack plates', terms);
    const apart = scoreMessage('plates for the rack', 'rack plates', terms);
    const one = scoreMessage('the rack is oak', 'rack plates', terms);
    expect(both).toBeGreaterThan(apart);
    expect(apart).toBeGreaterThan(one);
    expect(scoreMessage('nothing here', 'rack plates', terms)).toBe(0);
  });

  test('snippetAround centres on the first match', () => {
    const long = `${'x '.repeat(200)}the rack plates ${'y '.repeat(200)}`;
    const s = snippetAround(long, ['rack']);
    expect(s).toContain('rack plates');
    expect(s.startsWith('…')).toBe(true);
    expect(s.endsWith('…')).toBe(true);
  });
});
