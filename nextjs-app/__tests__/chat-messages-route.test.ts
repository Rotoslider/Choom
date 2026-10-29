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
