import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';

// GET /api/chats/[id] - Get a single chat with messages
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const chat = await prisma.chat.findUnique({
      where: { id },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
        },
        choom: true,
      },
    });

    if (!chat) {
      return NextResponse.json(
        { error: 'Chat not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(chat);
  } catch (error) {
    console.error('Failed to fetch chat:', error);
    return NextResponse.json(
      { error: 'Failed to fetch chat' },
      { status: 500 }
    );
  }
}

// PUT /api/chats/[id] - Update a chat
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { title, archived } = body;

    const chat = await prisma.chat.update({
      where: { id },
      data: {
        ...(title !== undefined && { title }),
        ...(archived !== undefined && { archived }),
      },
    });

    return NextResponse.json(chat);
  } catch (error) {
    console.error('Failed to update chat:', error);
    return NextResponse.json(
      { error: 'Failed to update chat' },
      { status: 500 }
    );
  }
}

// DELETE /api/chats/[id] - Delete a chat and its activity logs
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Delete associated activity logs first
    await prisma.activityLog.deleteMany({
      where: { chatId: id },
    });

    await prisma.chat.delete({
      where: { id },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete chat:', error);
    return NextResponse.json(
      { error: 'Failed to delete chat' },
      { status: 500 }
    );
  }
}
