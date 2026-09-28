/**
 * search_memories and auto-recall read the conversation index (memories +
 * private chats + rooms) — 2026-09-28. On the recall benchmark a short lookup
 * returned the current truth 88% of the time vs 67% for memory-only search.
 *
 * Hard rules pinned here: a room turn never sees private chats; auto-recall
 * skips the stretch of the current conversation already in the prompt; if the
 * index is down, everything falls back to the memory store.
 */
jest.mock('@/lib/db', () => ({
  __esModule: true,
  default: {
    generatedImage: { findMany: jest.fn().mockResolvedValue([]) },
    chat: { findMany: jest.fn().mockResolvedValue([]) },
    groupRoom: { findMany: jest.fn().mockResolvedValue([]) },
  },
}));

import * as fs from 'fs';
import * as path from 'path';
import MemoryManagementHandler from '@/skills/core/memory-management/handler';
import { buildChoomContext } from '@/lib/chat-context';
import { renderHit, localStamp, type ConversationHit } from '@/lib/recall-format';
import type { SkillHandlerContext } from '@/lib/skill-handler';

// Wed Sep 23 2026, 5:10 PM MDT
const TS = Date.UTC(2026, 8, 23, 23, 10) / 1000;
const HITS: ConversationHit[] = [
  { id: 'm1', source: 'chat', speaker: 'Donny', ts: TS, text: '[private chat · Donny] the canvas is on our wall' },
  { id: 'g1', source: 'room', speaker: 'Genesis', ts: TS + 60, text: '[room Family Time · Genesis] it looks perfect above the stove' },
  { id: 'mem_1', source: 'memory', speaker: 'memory', ts: TS + 120, text: 'Canvas arrived\nThe family canvas arrived a day early and is on the kitchen wall.' },
];

describe('renderHit', () => {
  test('labels who and where, local time, and "you" for her own lines', () => {
    expect(localStamp(TS)).toBe('2026-09-23 17:10');
    expect(renderHit(HITS[0], 'Genesis')).toEqual({ when: '2026-09-23 17:10', from: 'Donny · private chat', excerpt: 'the canvas is on our wall' });
    expect(renderHit(HITS[1], 'Genesis').from).toBe('you · room Family Time');
    expect(renderHit(HITS[1], 'Aloy').from).toBe('Genesis · room Family Time');
  });

  test('memories keep their title and id (update_memory takes the id)', () => {
    expect(renderHit(HITS[2], 'Genesis')).toEqual({
      when: '2026-09-23 17:12', from: 'your memory', title: 'Canvas arrived', id: 'mem_1',
      excerpt: 'The family canvas arrived a day early and is on the kitchen wall.',
    });
  });

  test('long text is clipped', () => {
    const r = renderHit({ ...HITS[0], text: '[private chat · Donny] ' + 'x'.repeat(900) }, 'Genesis', 100);
    expect(r.excerpt.length).toBe(100);
  });
});

function client(conv: { success: boolean; data?: unknown[] } | Error) {
  return {
    searchConversations: jest.fn(async () => { if (conv instanceof Error) throw conv; return conv; }),
    search: jest.fn(async () => ({ success: true, data: [{ id: 'old', title: 'Old path', content: 'memory store', timestamp: '2026-09-20T10:00:00-06:00' }] })),
  };
}

function ctx(c: ReturnType<typeof client>, extra: Partial<SkillHandlerContext> = {}) {
  return { memoryClient: c, memoryCompanionId: 'comp-gen', choomId: 'gen', choom: { name: 'Genesis' }, ...extra } as unknown as SkillHandlerContext;
}

describe('search_memories', () => {
  const h = new MemoryManagementHandler();
  const call = (args: Record<string, unknown>) => ({ id: 't1', name: 'search_memories', arguments: args });

  test('reads the conversation index and labels every result', async () => {
    const c = client({ success: true, data: HITS });
    const res = await h.execute(call({ query: 'canvas' }), ctx(c));
    expect(c.searchConversations).toHaveBeenCalledWith('canvas', 'gen', expect.objectContaining({ companionId: 'comp-gen', roomTurn: false, limit: 5 }));
    expect(c.search).not.toHaveBeenCalled();
    const r = res.result as { count: number; results: Array<{ from: string }>; note: string };
    expect(r.count).toBe(3);
    expect(r.results.map(x => x.from)).toEqual(['Donny · private chat', 'you · room Family Time', 'your memory']);
    expect(r.note).toContain('private chats');
  });

  test('a room turn asks for no private chats — from either signal', async () => {
    for (const extra of [{ isGroupTurn: true }, { groupRoomId: 'room-1' }]) {
      const c = client({ success: true, data: [] });
      const res = await h.execute(call({ query: 'canvas' }), ctx(c, extra));
      expect(c.searchConversations).toHaveBeenCalledWith('canvas', 'gen', expect.objectContaining({ roomTurn: true }));
      expect((res.result as { note: string }).note).not.toContain('private chats');
    }
  });

  test('index down or disabled → the memory store answers as before', async () => {
    for (const conv of [{ success: false, reason: 'Request failed: disabled' }, new Error('ECONNREFUSED')]) {
      const c = client(conv as never);
      const res = await h.execute(call({ query: 'canvas' }), ctx(c));
      expect(c.search).toHaveBeenCalled();
      expect((res.result as { memories: Array<{ title: string }> }).memories[0].title).toBe('Old path');
    }
  });

  test('detail=true keeps the raw memory-store form', async () => {
    const c = client({ success: true, data: HITS });
    await h.execute(call({ query: 'canvas', detail: true }), ctx(c));
    expect(c.searchConversations).not.toHaveBeenCalled();
    expect(c.search).toHaveBeenCalled();
  });
});

describe('auto-recall', () => {
  const base = {
    choom: { id: 'gen', name: 'Genesis' } as never, choomId: 'gen', chatId: 'chat-1', message: 'did the canvas come?',
    settings: {}, weatherSettings: {} as never, memoryCompanionId: 'comp-gen', isGroupTurn: false, groupRoomId: undefined,
  };

  test('private chat: skips the on-screen stretch of THIS chat and labels lines', async () => {
    const c = client({ success: true, data: HITS });
    const out = await buildChoomContext({ ...base, memoryClient: c as never, recallSkipSince: TS - 3600 });
    expect(c.searchConversations).toHaveBeenCalledWith('did the canvas come?', 'gen', expect.objectContaining({
      roomTurn: false, excludeThread: 'chat-1', excludeSince: TS - 3600, minRelevance: -2, limit: 5,
    }));
    expect(out.autoMemoriesInfo).toContain('## RELEVANT MEMORIES AND PAST CONVERSATIONS');
    expect(out.autoMemoriesInfo).toContain('- [2026-09-23 17:10 · Donny · private chat] the canvas is on our wall');
    expect(c.search).not.toHaveBeenCalled();
  });

  test('room turn: no private chats, skips the room transcript window', async () => {
    const c = client({ success: true, data: [HITS[1]] });
    const out = await buildChoomContext({ ...base, isGroupTurn: true, groupRoomId: 'room-1', memoryClient: c as never, recallSkipSince: TS });
    expect(c.searchConversations).toHaveBeenCalledWith(expect.any(String), 'gen', expect.objectContaining({ roomTurn: true, excludeThread: 'room-1', excludeSince: TS }));
    expect(out.autoMemoriesInfo).toContain('your memories and your rooms');
    expect(out.autoMemoriesInfo).not.toContain('private chats');
  });

  test('index unavailable → the old memory recall', async () => {
    const c = client({ success: false });
    const out = await buildChoomContext({ ...base, memoryClient: c as never });
    expect(c.search).toHaveBeenCalled();
    expect(out.autoMemoriesInfo).toContain('## RELEVANT MEMORIES (auto-recalled background)');
  });

  test('the route computes where the on-screen stretch starts (source contract)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../app/api/chat/route.ts'), 'utf8');
    expect(src).toContain('skip: groupMessages.length - 1,');
    expect(src).toContain('recallSkipSince = new Date(chat.messages[0].createdAt).getTime() / 1000;');
    expect(src).toContain('memoryClient, memoryCompanionId, isGroupTurn, groupRoomId, recallSkipSince,');
  });
});
