/**
 * GET /api/hologram/camera/frame?overlay=1&width=960: the glass camera's current picture (JPEG), for
 * the Camera tab's preview; overlay marks where it sees Donny's face (green while he's looking at the
 * glass). Home only; nothing is saved.
 */
import { NextResponse } from 'next/server';
import { requestFromAway } from '@/lib/hologram-bus';
import { askGlassCamera } from '@/lib/glass-camera';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  if (requestFromAway(request)) return NextResponse.json({ ok: false, error: 'Only from home.' }, { status: 403 });
  const url = new URL(request.url);
  const width = Math.max(320, Math.min(1280, Number(url.searchParams.get('width')) || 960));
  const answer = await askGlassCamera('frame', { width, overlay: url.searchParams.get('overlay') === '1', purpose: 'preview' }, 6000);
  if (!answer.ok || !answer.image) return NextResponse.json(answer, { status: answer.status ?? 503 });
  return new Response(new Uint8Array(Buffer.from(answer.image, 'base64')), {
    headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' },
  });
}
