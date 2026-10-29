/** GET /api/chats/[id]/messages?since=: only what's new in a chat (lib/chat-messages.ts). */
jest.mock('@/lib/db', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prisma } = require('./helpers/scratch-db');
  return { __esModule: true, default: prisma, prisma };
});

import { NextRequest } from 'next/server';
import { prisma, teardown } from './helpers/scratch-db';
import { GET } from '@/app/api/chats/[id]/messages/route';

afterAll(teardown);

test('since sends only the messages from that time on', async () => {
  const choom = await prisma.choom.create({ data: { name: 'Genesis' } });
  const chat = await prisma.chat.create({ data: { choomId: choom.id } });
  const times = ['2026-10-28T10:00:00Z', '2026-10-28T10:05:00Z', '2026-10-28T10:06:00Z'];
  for (const [i, at] of times.entries()) {
    await prisma.message.create({ data: { chatId: chat.id, role: 'user', content: `m${i}`, createdAt: new Date(at) } });
  }
  const get = (query: string) =>
    GET(new NextRequest(`http://localhost:3000/api/chats/${chat.id}/messages${query}`), { params: Promise.resolve({ id: chat.id }) });
  const contents = async (query: string) => ((await (await get(query)).json()) as { content: string }[]).map((m) => m.content);
  expect(await contents('')).toEqual(['m0', 'm1', 'm2']);
  expect(await contents('?since=2026-10-28T10:05:00.000Z')).toEqual(['m1', 'm2']);
  expect(await contents('?since=2026-10-28T11:00:00.000Z')).toEqual([]);
  expect((await get('?since=sometime')).status).toBe(400);
});

test('a page of the latest messages, the page before it, and how many come earlier', async () => {
  const choom = await prisma.choom.create({ data: { name: 'Eve' } });
  const chat = await prisma.chat.create({ data: { choomId: choom.id } });
  for (let i = 0; i < 7; i++) {
    await prisma.message.create({ data: { chatId: chat.id, role: 'user', content: `m${i}`, createdAt: new Date(Date.UTC(2026, 9, 28, 10, i)) } });
  }
  const get = (query: string) =>
    GET(new NextRequest(`http://localhost:3000/api/chats/${chat.id}/messages${query}`), { params: Promise.resolve({ id: chat.id }) });
  const latest = await get('?limit=3');
  const page = (await latest.json()) as { id: string; content: string }[];
  expect(page.map((m) => m.content)).toEqual(['m4', 'm5', 'm6']);
  expect(latest.headers.get('X-Earlier-Messages')).toBe('4');
  const before = await get(`?limit=3&beforeId=${page[0].id}`);
  const older = (await before.json()) as { id: string; content: string }[];
  expect(older.map((m) => m.content)).toEqual(['m1', 'm2', 'm3']);
  expect(before.headers.get('X-Earlier-Messages')).toBe('1');
  const first = await get(`?limit=3&beforeId=${older[0].id}`);
  expect(((await first.json()) as { content: string }[]).map((m) => m.content)).toEqual(['m0']);
  expect(first.headers.get('X-Earlier-Messages')).toBe('0');
  expect((await get('?limit=0')).status).toBe(400);
});

