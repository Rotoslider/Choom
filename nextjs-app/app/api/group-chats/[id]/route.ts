import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';

// GET /api/group-chats/[id] - Room + participants
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const room = await prisma.groupRoom.findUnique({
      where: { id },
      include: { participants: { include: { choom: true }, orderBy: { order: 'asc' } } },
    });
    if (!room) return NextResponse.json({ error: 'Room not found' }, { status: 404 });
    return NextResponse.json(room);
  } catch (error) {
    console.error('Failed to fetch room:', error);
    return NextResponse.json({ error: 'Failed to fetch room' }, { status: 500 });
  }
}

// PUT /api/group-chats/[id] - Update title / archived / autoRounds / participants
// Body: { title?, archived?, autoRounds?, participants?: [{ choomId, order?, active? }] | string[] }
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { title, archived, autoRounds, participants } = body;

    // If participants provided, replace the set.
    if (Array.isArray(participants)) {
      const normalized = participants.map((p: unknown, i: number) =>
        typeof p === 'string'
          ? { choomId: p, order: i, active: true }
          : { choomId: (p as { choomId: string }).choomId, order: (p as { order?: number }).order ?? i, active: (p as { active?: boolean }).active ?? true }
      );
      await prisma.groupParticipant.deleteMany({ where: { roomId: id } });
      await prisma.groupParticipant.createMany({
        data: normalized.map(p => ({ roomId: id, choomId: p.choomId, order: p.order, active: p.active })),
      });
    }

    const room = await prisma.groupRoom.update({
      where: { id },
      data: {
        ...(title !== undefined && { title }),
        ...(archived !== undefined && { archived }),
        ...(autoRounds !== undefined && { autoRounds: Math.max(0, Math.min(50, autoRounds)) }),
      },
      include: { participants: { include: { choom: true }, orderBy: { order: 'asc' } } },
    });
    return NextResponse.json(room);
  } catch (error) {
    console.error('Failed to update room:', error);
    return NextResponse.json({ error: 'Failed to update room' }, { status: 500 });
  }
}

// DELETE /api/group-chats/[id] - Delete room (cascades participants + messages)
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    // Clean up scratch chats anchored to this room's participants.
    const parts = await prisma.groupParticipant.findMany({ where: { roomId: id } });
    const scratchIds = parts.map(p => p.scratchChatId).filter((x): x is string => !!x);
    if (scratchIds.length) {
      await prisma.chat.deleteMany({ where: { id: { in: scratchIds } } });
    }
    // Remove ActivityLog rows for this room (group turns are tagged with the room
    // id) and any stragglers tagged with the now-deleted scratch chats. ActivityLog
    // has no FK relation, so these would otherwise be orphaned forever.
    await prisma.activityLog.deleteMany({ where: { chatId: { in: [id, ...scratchIds] } } });
    await prisma.groupRoom.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete room:', error);
    return NextResponse.json({ error: 'Failed to delete room' }, { status: 500 });
  }
}
