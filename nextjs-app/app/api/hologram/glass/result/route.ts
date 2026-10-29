/**
 * POST /api/hologram/glass/result: the hologram's answer to a glass_request (see lib/glass-closet.ts).
 * From the NUC at home only. `page` is what the glass at home showed for it (its page's glass events:
 * clothes to put on, a move to make); it goes out on the feed as glass_shown, so the travel glass
 * shows it too. She never sees it.
 */
import { NextResponse } from 'next/server';
import { publishHologram, requestFromAway } from '@/lib/hologram-bus';
import { resolveGlass, type GlassAnswer } from '@/lib/glass-closet';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  if (requestFromAway(request)) return NextResponse.json({ ok: false }, { status: 403 });
  const body = (await request.json().catch(() => null)) as (GlassAnswer & { id?: string; page?: unknown }) | null;
  if (!body || typeof body.id !== 'string') return NextResponse.json({ ok: false, error: 'id is required' }, { status: 400 });
  const { id, page, ...answer } = body;
  const shown = Array.isArray(page) ? page.filter((e) => !!e && typeof e === 'object') : [];
  if (shown.length) publishHologram({ type: 'glass_shown', events: shown });
  return NextResponse.json({ ok: resolveGlass(id, answer) });
}
