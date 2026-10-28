/**
 * /api/hologram/voice: the Looking Glass hologram's voice hand-off.
 *   POST { voice: boolean }  heartbeat from the hologram (every 10 s while it runs)
 *   GET  -> { voice }        true while a fresh heartbeat says the hologram is speaking and the
 *                            asking browser is at home. Browsers poll this and stay quiet while
 *                            it is true (lib/hologram-voice.ts). ?chat=ID or ?room=ID says what
 *                            the browser has open; the hologram speaks only those conversations.
 * "At home" is decided here, not by the browser's own address: a request that came in through
 * ngrok (a phone away from home) keeps its own voice, since nobody is in front of the hologram.
 *
 * The travel glass (choom-glass-player away from home) posts its heartbeat with its header
 * (X-Choom-Glass: travel), and a browser away from home at its address hands its voice to it
 * instead, and what it has open is spoken there (lib/hologram-bus.ts).
 */
import { NextResponse } from 'next/server';
import {
  atTravelGlass, forwardedFor, fromTravelGlass, hologramVoiceActive, markViewing, requestFromAway,
  setHologramVoice, setTravelGlassVoice, travelGlassActive,
} from '@/lib/hologram-bus';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const away = requestFromAway(request);
  const travel = away && atTravelGlass(request);
  if (!away || travel) {
    const params = new URL(request.url).searchParams;
    const chat = params.get('chat');
    const room = params.get('room');
    const place = travel ? 'travel' : 'home';
    if (chat) markViewing('chat', chat, place);
    if (room) markViewing('room', room, place);
  }
  if (travel) return NextResponse.json({ voice: travelGlassActive() });
  return NextResponse.json({ voice: hologramVoiceActive() && !away });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { voice?: unknown };
  if (fromTravelGlass(request)) {
    setTravelGlassVoice(body.voice === true, forwardedFor(request));
    return NextResponse.json({ voice: travelGlassActive() });
  }
  setHologramVoice(body.voice === true);
  return NextResponse.json({ voice: hologramVoiceActive() });
}
