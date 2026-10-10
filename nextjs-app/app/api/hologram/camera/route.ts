/**
 * GET /api/hologram/camera: the glass camera's state (on or off, the face it sees, its settings and
 * adjustments), for the Camera tab in Settings. POST with settings ({enabled, chooms, eye_contact,
 * yaw_limit, welcome, welcome_minutes}) and/or {controls: {name: value}} / {reset_controls: true}
 * changes them; the hologram keeps them on the NUC. Home only.
 */
import { NextResponse } from 'next/server';
import { requestFromAway } from '@/lib/hologram-bus';
import { askGlassCamera } from '@/lib/glass-camera';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  if (requestFromAway(request)) return NextResponse.json({ ok: false, error: 'Only from home.' }, { status: 403 });
  const answer = await askGlassCamera('state');
  return NextResponse.json(answer, { status: answer.ok ? 200 : 503 });
}

export async function POST(request: Request) {
  if (requestFromAway(request)) return NextResponse.json({ ok: false, error: 'Only from home.' }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const answer = await askGlassCamera('settings', body);
  return NextResponse.json(answer, { status: answer.ok ? 200 : 503 });
}
