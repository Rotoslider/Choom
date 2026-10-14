/**
 * POST /api/hologram/glass {choom, op: closet|move|wear|wish, what, kind?}: ask the Looking Glass for a Choom,
 * the way her looking-glass tools do (lib/glass-closet.ts). For trying her closet out by hand.
 * Home only.
 */
import { NextResponse } from 'next/server';
import { requestFromAway } from '@/lib/hologram-bus';
import { askGlass, type GlassOp } from '@/lib/glass-closet';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const OPS: GlassOp[] = ['closet', 'move', 'wear', 'wish'];

export async function POST(request: Request) {
  if (requestFromAway(request)) return NextResponse.json({ ok: false, error: 'Only from home.' }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { choom?: unknown; op?: unknown; what?: unknown; kind?: unknown };
  if (typeof body.choom !== 'string' || !body.choom.trim()) return NextResponse.json({ ok: false, error: 'choom is required' }, { status: 400 });
  const op = OPS.find((o) => o === body.op);
  if (!op) return NextResponse.json({ ok: false, error: 'op is closet, move, wear or wish' }, { status: 400 });
  const answer = await askGlass(body.choom.trim(), op, typeof body.what === 'string' ? body.what : '',
    op === 'wish' ? (body.kind === 'move' ? 'move' : 'wear') : undefined);
  return NextResponse.json(answer, { status: answer.ok ? 200 : 503 });
}
