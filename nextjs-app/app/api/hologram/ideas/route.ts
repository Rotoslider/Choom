/**
 * POST /api/hologram/ideas {choom, look, about}: Glass Studio asks a Choom for ideas for one of her looks
 * (lib/glass-ideas.ts). It queues a request in her follow-up queue that fires within a minute; she
 * answers with glass_wish and a line to Donny. Answers {ok, id, already}. Home only.
 */
import { NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { requestFromAway } from '@/lib/hologram-bus';
import { ABOUT_MAX, queueIdeas } from '@/lib/glass-ideas';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  if (requestFromAway(request)) return NextResponse.json({ ok: false, error: 'Only from home.' }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { choom?: unknown; look?: unknown; about?: unknown };
  const name = typeof body.choom === 'string' ? body.choom.trim() : '';
  const look = typeof body.look === 'string' ? body.look.trim() : '';
  const about = typeof body.about === 'string' ? body.about.trim().slice(0, ABOUT_MAX) : '';
  if (!name || !look || !about) return NextResponse.json({ ok: false, error: 'choom, look and about are required' }, { status: 400 });
  const chooms = await prisma.choom.findMany({ select: { id: true, name: true } });
  const choom = chooms.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (!choom) return NextResponse.json({ ok: false, error: `No Choom named ${name}` }, { status: 404 });
  const { entry, already } = queueIdeas(choom, look, about);
  return NextResponse.json({ ok: true, id: entry.id, already });
}
