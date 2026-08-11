import { NextRequest } from 'next/server';
import prisma from '../lib/db';
import { GET, PUT } from '../app/api/chooms/[id]/route';

let choomId = '';

beforeEach(async () => {
  const choom = await prisma.choom.create({
    data: { name: `SSH Permission API ${Date.now()}-${Math.random().toString(16).slice(2)}` },
  });
  choomId = choom.id;
});

afterEach(async () => {
  if (choomId) await prisma.choom.delete({ where: { id: choomId } });
  choomId = '';
});

describe('Choom SSH permission API', () => {
  it('persists and returns the Remote SSH grant as parsed JSON', async () => {
    const request = new NextRequest(`http://localhost/api/chooms/${choomId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissions: { ssh: true } }),
    });

    const updateResponse = await PUT(request, { params: Promise.resolve({ id: choomId }) });
    expect(updateResponse.status).toBe(200);
    expect((await updateResponse.json()).permissions).toEqual({ ssh: true });

    const getResponse = await GET(
      new NextRequest(`http://localhost/api/chooms/${choomId}`),
      { params: Promise.resolve({ id: choomId }) },
    );
    expect(getResponse.status).toBe(200);
    expect((await getResponse.json()).permissions).toEqual({ ssh: true });
  });
});
