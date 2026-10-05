/**
 * /api/hologram/voice: the Looking Glass hologram's voice hand-off.
 *   POST { voice: boolean }  heartbeat from the hologram (every 10 s while it runs)
 *   GET  -> { voice }        true while a fresh heartbeat says the hologram is speaking and the
 *                            asking browser is at home. Browsers poll this and stay quiet while
 *                            it is true (lib/hologram-voice.ts).
 * "At home" is decided here, not by the browser's own address: a request that came in through
 * ngrok (a phone away from home) keeps its own voice, since nobody is in front of the hologram.
 */
import { NextResponse } from 'next/server';
import { hologramVoiceActive, setHologramVoice } from '@/lib/hologram-bus';

export const dynamic = 'force-dynamic';

const PRIVATE_IP = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fe80:|fc|fd)/i;

function fromAway(request: Request): boolean {
  const host = request.headers.get('host') ?? '';
  if (/ngrok/i.test(host)) return true;
  const forwarded = (request.headers.get('x-forwarded-for') ?? '').split(',')[0].trim();
  return forwarded !== '' && !PRIVATE_IP.test(forwarded.replace(/^::ffff:/, ''));
}

export async function GET(request: Request) {
  return NextResponse.json({ voice: hologramVoiceActive() && !fromAway(request) });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { voice?: unknown };
  setHologramVoice(body.voice === true);
  return NextResponse.json({ voice: hologramVoiceActive() });
}
