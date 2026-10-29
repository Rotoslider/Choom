/**
 * GET /api/chooms/[id]/avatar: her avatar picture itself (lib/choom-avatar.ts). With ?v= (its fingerprint)
 * the browser may keep it for good: a new picture gets a new link.
 */
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { avatarImage } from '@/lib/choom-avatar';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const choom = await prisma.choom.findUnique({ where: { id }, select: { avatarUrl: true } });
  if (!choom?.avatarUrl) return NextResponse.json({ error: 'no avatar' }, { status: 404 });
  const image = avatarImage(choom.avatarUrl);
  if (!image) return NextResponse.redirect(new URL(choom.avatarUrl, request.url));
  const versioned = request.nextUrl.searchParams.has('v');
  return new NextResponse(new Uint8Array(image.bytes), {
    headers: {
      'Content-Type': image.type,
      'Content-Length': String(image.bytes.length),
      'Cache-Control': versioned ? 'private, max-age=31536000, immutable' : 'no-cache',
    },
  });
}
