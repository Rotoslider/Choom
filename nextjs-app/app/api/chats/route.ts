import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';

// GET /api/chats - List chats (optionally filtered by choomId)
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const choomId = searchParams.get('choomId');
    const includeArchived = searchParams.get('archived') === 'true';

    const chats = await prisma.chat.findMany({
      where: {
        ...(choomId && { choomId }),
        ...(!includeArchived && { archived: false }),
      },
      orderBy: { updatedAt: 'desc' },
    });

    return NextResponse.json(chats);
  } catch (error) {
    console.error('Failed to fetch chats:', error);
    return NextResponse.json(
      { error: 'Failed to fetch chats' },
      { status: 500 }
    );
  }
}

// POST /api/chats - Create a new chat
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { choomId, title } = body;

    if (!choomId) {
      return NextResponse.json(
        { error: 'choomId is required' },
        { status: 400 }
      );
    }

    // Verify choom exists
    const choom = await prisma.choom.findUnique({
      where: { id: choomId },
    });

    if (!choom) {
      return NextResponse.json(
        { error: 'Choom not found' },
        { status: 404 }
      );
    }

    const chat = await prisma.chat.create({
      data: {
        choomId,
        title: title || null,
      },
    });

    return NextResponse.json(chat, { status: 201 });
  } catch (error) {
    console.error('Failed to create chat:', error);
    return NextResponse.json(
      { error: 'Failed to create chat' },
      { status: 500 }
    );
  }
}
