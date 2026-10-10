/**
 * POST /api/hologram/glass/result: the hologram's answer to a glass_request (see lib/glass-closet.ts).
 * From the NUC at home only.
 */
import { NextResponse } from 'next/server';
import { requestFromAway } from '@/lib/hologram-bus';
import { resolveGlass, type GlassAnswer } from '@/lib/glass-closet';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  if (requestFromAway(request)) return NextResponse.json({ ok: false }, { status: 403 });
  const body = (await request.json().catch(() => null)) as (GlassAnswer & { id?: string }) | null;
  if (!body || typeof body.id !== 'string') return NextResponse.json({ ok: false, error: 'id is required' }, { status: 400 });
  const { id, ...answer } = body;
  return NextResponse.json({ ok: resolveGlass(id, answer) });
}
