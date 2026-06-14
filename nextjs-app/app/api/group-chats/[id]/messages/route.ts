import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';

// GET /api/group-chats/[id]/messages - Full room transcript (asc).
// Used for initial load and cross-device polling (web ↔ Signal).
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const since = searchParams.get('since'); // ISO timestamp — return only newer messages

    const messages = await prisma.groupMessage.findMany({
      where: { roomId: id, ...(since && { createdAt: { gt: new Date(since) } }) },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
    return NextResponse.json(messages);
  } catch (error) {
    console.error('Failed to fetch room messages:', error);
    return NextResponse.json({ error: 'Failed to fetch room messages' }, { status: 500 });
  }
}
