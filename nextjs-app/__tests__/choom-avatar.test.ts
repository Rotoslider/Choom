/** Her avatar as a link to the picture, kept by the browser until it changes (lib/choom-avatar.ts). */
jest.mock('@/lib/db', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prisma } = require('./helpers/scratch-db');
  return { __esModule: true, default: prisma, prisma };
});

import { NextRequest } from 'next/server';
import { prisma, teardown } from './helpers/scratch-db';
import { avatarLink, isAvatarLink } from '@/lib/choom-avatar';
import { GET as listChooms } from '@/app/api/chooms/route';
import { PUT as updateChoom } from '@/app/api/chooms/[id]/route';
import { GET as avatar } from '@/app/api/chooms/[id]/avatar/route';

afterAll(teardown);

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const dataUri = (b64: string) => `data:image/png;base64,${b64}`;

test('a picture becomes a link by its fingerprint; a web address or nothing stays as it is', () => {
  const a = avatarLink('c1', dataUri(PNG));
  expect(a).toMatch(/^\/api\/chooms\/c1\/avatar\?v=[0-9a-f]{12}$/);
  expect(avatarLink('c1', dataUri(PNG))).toBe(a);
  expect(avatarLink('c1', dataUri(PNG.replace('AAAA', 'AAAB')))).not.toBe(a);
  expect(avatarLink('c1', 'https://example.com/me.png')).toBe('https://example.com/me.png');
  expect(avatarLink('c1', null)).toBeNull();
  expect(isAvatarLink(a, 'c1')).toBe(true);
  expect(isAvatarLink(a, 'c2')).toBe(false);
  expect(isAvatarLink(dataUri(PNG), 'c1')).toBe(false);
});

test('the list carries the link, the link serves the picture, and saving the link back keeps it', async () => {
  const choom = await prisma.choom.create({ data: { name: 'Genesis', avatarUrl: dataUri(PNG) } });
  const listed = (await (await listChooms()).json()) as { id: string; avatarUrl: string }[];
  const link = listed.find((c) => c.id === choom.id)!.avatarUrl;
  expect(link).toBe(avatarLink(choom.id, dataUri(PNG)));

  const res = await avatar(new NextRequest(`http://localhost:3000${link}`), { params: Promise.resolve({ id: choom.id }) });
  expect(res.headers.get('content-type')).toBe('image/png');
  expect(res.headers.get('cache-control')).toContain('immutable');
  expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(PNG, 'base64'))).toBe(true);

  const put = (body: unknown) => updateChoom(new NextRequest(`http://localhost:3000/api/chooms/${choom.id}`, {
    method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
  }), { params: Promise.resolve({ id: choom.id }) });
  expect((await (await put({ name: 'Genesis', avatarUrl: link })).json()).avatarUrl).toBe(link);
  expect((await prisma.choom.findUnique({ where: { id: choom.id } }))!.avatarUrl).toBe(dataUri(PNG));
  const changed = dataUri(PNG.replace('AAAA', 'AAAB'));
  expect((await (await put({ avatarUrl: changed })).json()).avatarUrl).toBe(avatarLink(choom.id, changed));
  expect((await prisma.choom.findUnique({ where: { id: choom.id } }))!.avatarUrl).toBe(changed);
});
