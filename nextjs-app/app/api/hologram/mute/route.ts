/**
 * POST /api/hologram/mute { muted: boolean }: the web app's mute button reaching the Looking Glass
 * hologram, so one press silences every voice (lib/hologram-voice.ts sends it).
 */
import { NextResponse } from 'next/server';
import { setHologramMuted } from '@/lib/hologram-bus';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { muted?: unknown };
  setHologramMuted(body.muted === true);
  return NextResponse.json({ ok: true });
}
