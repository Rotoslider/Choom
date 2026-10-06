/**
 * POST /api/hologram/talk { choom, text }: Donny talking to a Choom at the tower ("OK Genesis, ..."),
 * heard by the hologram's microphone on the NUC and transcribed there.
 *
 * His words go to her current 1:1 chat, picked the way Signal picks it (the most recently updated
 * chat that isn't an autonomous, delegation, briefing or group-scratch thread), with the server's
 * own settings, as a message he started. While her turn runs, the chat stays marked as open at home,
 * so the hologram speaks her reply. Answers as soon as the turn has started; the turn runs on here
 * and the hologram follows it on its own feed. Ignored from away. { dryRun: true } only reports
 * which chat it would use.
 *
 * { room: true, text } ("OK Chooms, ..."): his words go to the Signal room (the room set as "Signal
 * room" on the Rooms page), or else the room he last spoke in, as if he had typed them there, and the
 * room stays marked as open at home while it runs.
 */
import { readFile } from 'fs/promises';
import { join } from 'path';
import { NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { markViewing, requestFromAway } from '@/lib/hologram-bus';
import { GET as serverSettings } from '@/app/api/settings/defaults/route';

export const dynamic = 'force-dynamic';

const NOT_HIS_CONVERSATION = /^(\[Delegation\]|\[Autonomous\]|Briefing )/;

export async function POST(request: Request) {
  if (requestFromAway(request)) return NextResponse.json({ ok: false, away: true }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { choom?: unknown; text?: unknown; dryRun?: unknown; room?: unknown };
  const name = typeof body.choom === 'string' ? body.choom.trim().toLowerCase() : '';
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (body.room === true) return talkToRoom(request, text, body.dryRun === true);
  if (!name || !text) return NextResponse.json({ ok: false, error: 'choom and text are required' }, { status: 400 });

  const choom = (await prisma.choom.findMany()).find((c) => c.name.toLowerCase() === name);
  if (!choom) return NextResponse.json({ ok: false, error: `no Choom named ${String(body.choom)}` }, { status: 404 });

  const chats = await prisma.chat.findMany({ where: { choomId: choom.id, archived: false }, orderBy: { updatedAt: 'desc' } });
  const chat = chats.find((c) => !c.title || !(c.title.includes('[group scratch]') || NOT_HIS_CONVERSATION.test(c.title)))
    ?? (await prisma.chat.create({ data: { choomId: choom.id } }));

  // dryRun: which chat it would go to, without sending anything (for checking from the NUC).
  if (body.dryRun === true) return NextResponse.json({ ok: true, dryRun: true, choom: choom.name, chatId: chat.id, chatTitle: chat.title });

  const settings = await (await serverSettings(request)).json();
  // Her reply can take half a minute to start; keep the chat "open at home" until the turn ends.
  markViewing('chat', chat.id);
  const keepOpen = setInterval(() => markViewing('chat', chat.id), 10_000);

  let response: Response;
  try {
    response = await fetch(new URL('/api/chat', request.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ choomId: choom.id, chatId: chat.id, message: text, settings, userInitiated: true }),
    });
  } catch (e) {
    clearInterval(keepOpen);
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
  if (!response.ok || !response.body) {
    clearInterval(keepOpen);
    return NextResponse.json({ ok: false, error: `chat answered ${response.status}` }, { status: 502 });
  }
  drain(response, keepOpen);
  return NextResponse.json({ ok: true, choom: choom.name, chatId: chat.id });
}

/** The turn streams on here to its end (the hologram has its own feed); then the room or chat closes. */
function drain(response: Response, keepOpen: ReturnType<typeof setInterval>) {
  const reader = response.body!.getReader();
  void (async () => {
    try {
      while (!(await reader.read()).done) { /* the turn streams on; the hologram has its own feed */ }
    } catch {
      // The turn ended early; nothing to clean up beyond the timer.
    } finally {
      clearInterval(keepOpen);
    }
  })();
}

async function talkToRoom(request: Request, text: string, dryRun: boolean) {
  if (!text) return NextResponse.json({ ok: false, error: 'text is required' }, { status: 400 });
  // The Signal room if one is set (bridge-config defaultGroupRoomId), else the room he last spoke in
  // (his messages have no Choom as author); the Chooms' own rooms update all the time, so "most
  // recently updated" would often be one he isn't in.
  const config = await readFile(join(process.cwd(), 'services', 'signal-bridge', 'bridge-config.json'), 'utf-8')
    .then((t) => JSON.parse(t) as { defaultGroupRoomId?: string | null }).catch(() => ({ defaultGroupRoomId: null }));
  const signalRoom = config.defaultGroupRoomId
    ? await prisma.groupRoom.findUnique({ where: { id: config.defaultGroupRoomId } })
    : null;
  const room = signalRoom && !signalRoom.archived ? signalRoom : (await prisma.groupMessage.findFirst({
    where: { role: 'user', authorChoomId: null, room: { archived: false } },
    orderBy: { createdAt: 'desc' },
    include: { room: true },
  }))?.room;
  if (!room) return NextResponse.json({ ok: false, error: 'no Signal room and no room he has spoken in' }, { status: 404 });
  if (dryRun) return NextResponse.json({ ok: true, dryRun: true, roomId: room.id, room: room.title });

  const settings = await (await serverSettings(request)).json();
  markViewing('room', room.id);
  const keepOpen = setInterval(() => markViewing('room', room.id), 10_000);
  let response: Response;
  try {
    response = await fetch(new URL('/api/group-chat', request.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: room.id, message: text, settings }),
    });
  } catch (e) {
    clearInterval(keepOpen);
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
  if (!response.ok || !response.body) {
    clearInterval(keepOpen);
    return NextResponse.json({ ok: false, error: `group chat answered ${response.status}` }, { status: 502 });
  }
  drain(response, keepOpen);
  return NextResponse.json({ ok: true, roomId: room.id, room: room.title });
}
