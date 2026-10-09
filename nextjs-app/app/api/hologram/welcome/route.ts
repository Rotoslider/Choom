/**
 * POST /api/hologram/welcome { awayMinutes, place? }: Donny just sat back down at his desk after a
 * while away (the hologram's camera and the NUC's keyboard tell it). The Choom he last talked with
 * one to one (his most recent genuine message, lastUserMessageAt) gets a note in that chat and
 * welcomes him back in her own words; if he'd told her where he was going, she knows from the
 * conversation. The note is a system message: not shown in the chat, never counted as his words.
 * Nothing happens if he hasn't talked with anyone for 12 hours. Ignored from away. { dryRun: true }
 * only reports who it would be.
 */
import { NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { markViewing, requestFromAway } from '@/lib/hologram-bus';
import { GET as serverSettings } from '@/app/api/settings/defaults/route';

export const dynamic = 'force-dynamic';

const RECENT_MS = 12 * 60 * 60 * 1000;

export async function POST(request: Request) {
  if (requestFromAway(request)) return NextResponse.json({ ok: false, away: true }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { awayMinutes?: unknown; place?: unknown; dryRun?: unknown };
  const minutes = typeof body.awayMinutes === 'number' && body.awayMinutes > 0 ? Math.round(body.awayMinutes) : null;
  if (!minutes) return NextResponse.json({ ok: false, error: 'awayMinutes is required' }, { status: 400 });
  const place = typeof body.place === 'string' && /^[a-z ]{1,30}$/i.test(body.place) ? body.place : null;

  const chat = await prisma.chat.findFirst({
    where: { archived: false, lastUserMessageAt: { not: null } },
    orderBy: { lastUserMessageAt: 'desc' },
    include: { choom: true },
  });
  if (!chat || !chat.lastUserMessageAt || Date.now() - chat.lastUserMessageAt.getTime() > RECENT_MS) {
    return NextResponse.json({ ok: false, skipped: 'no conversation in the last 12 hours' });
  }
  if (body.dryRun === true) {
    return NextResponse.json({ ok: true, dryRun: true, choom: chat.choom.name, chatId: chat.id, chatTitle: chat.title });
  }

  const away = minutes >= 90 ? `about ${Math.round(minutes / 60)} hours` : `about ${minutes} minutes`;
  const note = `[Note from the house, not from Donny: he just sat back down at his desk after ${away} away${place ? ` (he was in the ${place})` : ''}. `
    + 'If your conversation tells you where he went or what he was doing, welcome him back and ask how it went, in a sentence or two. '
    + "Otherwise a short, warm welcome back is enough. Don't mention this note or how you knew.]";

  const settings = await (await serverSettings(request)).json();
  markViewing('chat', chat.id);
  const keepOpen = setInterval(() => markViewing('chat', chat.id), 10_000);
  let response: Response;
  try {
    response = await fetch(new URL('/api/chat', request.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ choomId: chat.choomId, chatId: chat.id, message: note, note: true, settings }),
    });
  } catch (e) {
    clearInterval(keepOpen);
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
  if (!response.ok || !response.body) {
    clearInterval(keepOpen);
    return NextResponse.json({ ok: false, error: `chat answered ${response.status}` }, { status: 502 });
  }
  const reader = response.body.getReader();
  void (async () => {
    try { while (!(await reader.read()).done) { /* the hologram follows on its own feed */ } }
    catch { /* ended early */ }
    finally { clearInterval(keepOpen); }
  })();
  return NextResponse.json({ ok: true, choom: chat.choom.name, chatId: chat.id });
}
