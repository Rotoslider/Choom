import { NextResponse } from 'next/server';
import prisma from '@/lib/db';

// GET /api/chooms/recent-user
// Returns the Choom the OWNER most recently had a genuine conversation with, on
// ANY surface (web or Signal). Powers cross-surface routing: an un-addressed
// Signal message goes to whoever you were last actually talking to.
//
// "Genuine" = a turn where the owner actually typed (Chat.lastUserMessageAt is
// stamped in /api/chat only when userInitiated && !heartbeat/group/delegation).
// Heartbeats, self-followups, cron and briefings never bump it, so they can't
// hijack who answers. Group scratch + delegation chats are excluded by title.
export async function GET() {
  try {
    const chat = await prisma.chat.findFirst({
      where: {
        archived: false,
        lastUserMessageAt: { not: null },
        NOT: [
          { title: { contains: '[group scratch]' } },
          { title: { startsWith: '[Delegation]' } },
        ],
      },
      orderBy: { lastUserMessageAt: 'desc' },
      include: { choom: { select: { id: true, name: true } } },
    });

    if (!chat?.choom) {
      return NextResponse.json({ choom: null });
    }

    return NextResponse.json({
      choom: { id: chat.choom.id, name: chat.choom.name },
      chatId: chat.id,
      lastUserMessageAt: chat.lastUserMessageAt,
    });
  } catch (error) {
    console.error('Failed to resolve recent-user Choom:', error);
    return NextResponse.json(
      { error: 'Failed to resolve recent-user Choom' },
      { status: 500 }
    );
  }
}
