/**
 * POST /api/hologram/camera/result: the hologram's answer to a camera_request (see lib/glass-camera.ts).
 * From the NUC at home only.
 */
import { NextResponse } from 'next/server';
import { requestFromAway } from '@/lib/hologram-bus';
import { resolveGlassCamera, type GlassCameraAnswer } from '@/lib/glass-camera';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  if (requestFromAway(request)) return NextResponse.json({ ok: false }, { status: 403 });
  const body = (await request.json().catch(() => null)) as (GlassCameraAnswer & { id?: string }) | null;
  if (!body || typeof body.id !== 'string') return NextResponse.json({ ok: false, error: 'id is required' }, { status: 400 });
  const { id, ...answer } = body;
  return NextResponse.json({ ok: resolveGlassCamera(id, answer) });
}
