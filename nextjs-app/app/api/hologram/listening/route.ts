/**
 * POST /api/hologram/listening { listening, source: 'mic' | 'typing', chat?, room?, choom? }:
 * Donny typing to a Choom or talking into the mic at home, so the Looking Glass hologram shows her
 * listening. Sent by lib/hologram-voice.ts from the chat input; ignored from away (nobody is in
 * front of the hologram then).
 */
import { NextResponse } from 'next/server';
import { requestFromAway, setHologramListening } from '@/lib/hologram-bus';

export const dynamic = 'force-dynamic';

const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export async function POST(request: Request) {
  if (requestFromAway(request)) return NextResponse.json({ ok: false, away: true });
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  setHologramListening({
    listening: body.listening === true,
    source: body.source === 'mic' ? 'mic' : 'typing',
    chatId: text(body.chat),
    roomId: text(body.room),
    choom: text(body.choom),
  });
  return NextResponse.json({ ok: true });
}
