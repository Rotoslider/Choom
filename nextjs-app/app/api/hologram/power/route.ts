/**
 * /api/hologram/power: the Glass button (lib/glass-power.ts).
 *   GET  -> { off, glass }  off: the picture is switched off (as pressed); glass: what the glass
 *                           says it is doing ('off', 'on', or null when it isn't running)
 *   POST { off: boolean }   switch the picture off (saving power; voices still play) or on
 */
import { NextResponse } from 'next/server';
import { glassOff, glassReported, setGlassOff } from '@/lib/glass-power';

export const dynamic = 'force-dynamic';

function state() {
  const reported = glassReported();
  return { off: glassOff(), glass: reported === null ? null : reported ? 'off' : 'on' };
}

export async function GET() {
  return NextResponse.json(state());
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { off?: unknown };
  if (typeof body.off !== 'boolean') return NextResponse.json({ error: 'off (true or false) is required' }, { status: 400 });
  if (body.off !== glassOff()) setGlassOff(body.off);
  return NextResponse.json(state());
}
