import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';

// GET /api/chats/[id]/messages - Get messages for a chat
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const messages = await prisma.message.findMany({
      where: { chatId: id },
      orderBy: { createdAt: 'asc' },
    });

    return NextResponse.json(messages);
  } catch (error) {
    console.error('Failed to fetch messages:', error);
    return NextResponse.json(
      { error: 'Failed to fetch messages' },
      { status: 500 }
    );
  }
}

// POST /api/chats/[id]/messages - Add a message to a chat
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: chatId } = await params;
    const body = await request.json();
    const { role, content, toolCalls, toolResults } = body;

    if (!role || !content) {
      return NextResponse.json(
        { error: 'role and content are required' },
        { status: 400 }
      );
    }

    // Verify chat exists
    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
    });

    if (!chat) {
      return NextResponse.json(
        { error: 'Chat not found' },
        { status: 404 }
      );
    }

    const message = await prisma.message.create({
      data: {
        chatId,
        role,
        content,
        toolCalls: toolCalls ? JSON.stringify(toolCalls) : null,
        toolResults: toolResults ? JSON.stringify(toolResults) : null,
      },
    });

    // Update chat's updatedAt
    await prisma.chat.update({
      where: { id: chatId },
      data: { updatedAt: new Date() },
    });

    // Auto-generate chat title from first user message if not set
    if (role === 'user' && !chat.title) {
      const title = content.slice(0, 30) + (content.length > 30 ? '...' : '');
      await prisma.chat.update({
        where: { id: chatId },
        data: { title },
      });
    }

    return NextResponse.json(message, { status: 201 });
  } catch (error) {
    console.error('Failed to create message:', error);
    return NextResponse.json(
      { error: 'Failed to create message' },
      { status: 500 }
    );
  }
}
