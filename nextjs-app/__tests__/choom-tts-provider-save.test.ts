/**
 * Nov 22 2026: the edit panel's "TTS server" choice (Choom.ttsProviderId) was
 * sent on every save but dropped by PUT /api/chooms/[id], so a Choom could
 * never be switched to another TTS provider (Drama 3). Now it saves, clears
 * with "" or null, and is left alone when the field isn't sent.
 */
jest.mock('@/lib/db', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prisma } = require('./helpers/scratch-db');
  return { __esModule: true, default: prisma, prisma };
});

import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { PUT } from '@/app/api/chooms/[id]/route';

const put = (id: string, body: object) =>
  PUT(new NextRequest(`http://localhost/api/chooms/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) });

describe('PUT /api/chooms/[id] saves the TTS provider', () => {
  let id: string;
  beforeAll(async () => {
    id = (await prisma.choom.create({ data: { name: 'Voice Test', voiceId: 'aloy' } })).id;
  });

  test('set, keep when absent, clear', async () => {
    expect((await put(id, { ttsProviderId: 'tts_drama3' })).status).toBe(200);
    expect((await prisma.choom.findUnique({ where: { id } }))?.ttsProviderId).toBe('tts_drama3');

    await put(id, { description: 'no provider in this save' });
    expect((await prisma.choom.findUnique({ where: { id } }))?.ttsProviderId).toBe('tts_drama3');

    await put(id, { ttsProviderId: '' });
    expect((await prisma.choom.findUnique({ where: { id } }))?.ttsProviderId).toBeNull();
  });
});
