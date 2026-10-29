/**
 * POST /api/hologram/talk { choom, text }: Donny talking to a Choom at the tower ("OK Genesis, ..."),
 * heard by the hologram's microphone on the NUC and transcribed there.
 *
 * His words go to her current 1:1 chat, picked the way Signal picks it (the most recently updated
 * chat that isn't an autonomous, delegation, briefing or group-scratch thread), with the server's
 * own settings, as a message he started. While her turn runs, the chat stays marked as open at home,
 * so the hologram speaks her reply. Answers as soon as the turn has started; the turn runs on here
 * and the hologram follows it on its own feed. Ignored from away, except from the travel glass
 * (its mic, choom-glass-player): then the conversation is kept open there, so that glass speaks
 * the reply and the one at home doesn't. While the travel glass runs, the tower's own mic is refused
 * (409): he's at the travel glass, the home glass is quiet, and in one room both mics heard "OK Genesis"
 * and sent it twice. { dryRun: true } only reports which chat it would use.
 *
 * { room: true, text } ("OK Chooms, ..."): his words go to the Signal room (the room set as "Signal
 * room" on the Rooms page), or else the room he last spoke in, as if he had typed them there, and the
 * room stays marked as open at home while it runs.
 */
import { readFile } from 'fs/promises';
import { join } from 'path';
import { NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { fromTravelGlass, markViewing, requestFromAway, travelGlassRunning, type GlassPlace } from '@/lib/hologram-bus';
import { GET as serverSettings } from '@/app/api/settings/defaults/route';

export const dynamic = 'force-dynamic';

const NOT_HIS_CONVERSATION = /^(\[Delegation\]|\[Autonomous\]|Briefing )/;

export async function POST(request: Request) {
  const place: GlassPlace = fromTravelGlass(request) ? 'travel' : 'home';
  if (requestFromAway(request) && place !== 'travel') return NextResponse.json({ ok: false, away: true }, { status: 403 });
  if (place === 'home' && travelGlassRunning()) return NextResponse.json({ ok: false, travelGlass: true }, { status: 409 });
  const body = (await request.json().catch(() => ({}))) as { choom?: unknown; text?: unknown; dryRun?: unknown; room?: unknown };
  const name = typeof body.choom === 'string' ? body.choom.trim().toLowerCase() : '';
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (body.room === true) return talkToRoom(request, text, body.dryRun === true, place);
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
  markViewing('chat', chat.id, place);
  const keepOpen = setInterval(() => markViewing('chat', chat.id, place), 10_000);

  const failed = await startTurn(new URL('/api/chat', request.url),
    { choomId: choom.id, chatId: chat.id, message: text, settings, userInitiated: true }, keepOpen, 'chat');
  if (failed) return NextResponse.json({ ok: false, error: failed }, { status: 502 });
  return NextResponse.json({ ok: true, choom: choom.name, chatId: chat.id });
}

/**
 * Send his words on, and answer once the turn has begun: as soon as the chat accepts them, or after a few
 * seconds while it's still thinking. Its answer only starts with her first words, and a local model
 * reading a long chat took 84 s to them (Eve, 2026-10-28): the tower gave up at 60 s and never opened its
 * reply window. The turn streams on here to its end either way. An error text, or null when it's under way.
 */
async function startTurn(url: URL, body: unknown, keepOpen: ReturnType<typeof setInterval>, what: string): Promise<string | null> {
  const reply = fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then((response) => {
      if (!response.ok || !response.body) {
        clearInterval(keepOpen);
        return `${what} answered ${response.status}`;
      }
      drain(response, keepOpen);
      return null;
    }, (e: unknown) => {
      clearInterval(keepOpen);
      return e instanceof Error ? e.message : String(e);
    });
  const startedMs = Number(process.env.HOLOGRAM_TALK_STARTED_MS) || 5_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const thinking = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), startedMs); });
  const first = await Promise.race([reply, thinking]);
  clearTimeout(timer);
  return first;
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

async function talkToRoom(request: Request, text: string, dryRun: boolean, place: GlassPlace) {
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
  markViewing('room', room.id, place);
  const keepOpen = setInterval(() => markViewing('room', room.id, place), 10_000);
  const failed = await startTurn(new URL('/api/group-chat', request.url), { roomId: room.id, message: text, settings }, keepOpen, 'group chat');
  if (failed) return NextResponse.json({ ok: false, error: failed }, { status: 502 });
  return NextResponse.json({ ok: true, roomId: room.id, room: room.title });
}
