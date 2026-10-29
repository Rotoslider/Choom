import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';

// GET /api/chats/[id]/messages - Get messages for a chat (see lib/chat-messages.ts):
//   ?since=<ISO time>        only the messages from that time on (what's new since the page looked)
//   ?limit=<n>               only the latest n; with &beforeId=<message id>, the n just before that one
// A page of messages comes with X-Earlier-Messages: how many come before it.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const query = request.nextUrl.searchParams;
    const sinceParam = query.get('since');
    const since = sinceParam ? new Date(sinceParam) : null;
    if (since && Number.isNaN(since.getTime())) {
      return NextResponse.json({ error: 'since must be a time' }, { status: 400 });
    }
    const limit = query.has('limit') ? Number(query.get('limit')) : null;
    if (limit !== null && !(Number.isInteger(limit) && limit > 0)) {
      return NextResponse.json({ error: 'limit must be a whole number above 0' }, { status: 400 });
    }
    if (limit !== null) {
      // Newest first so the page is the latest ones (before the cursor, if any), then put in order.
      const beforeId = query.get('beforeId');
      const page = (await prisma.message.findMany({
        where: { chatId: id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        ...(beforeId ? { cursor: { id: beforeId }, skip: 1 } : {}),
      })).reverse();
      const oldest = page[0];
      const earlier = oldest ? await prisma.message.count({
        where: { chatId: id, OR: [{ createdAt: { lt: oldest.createdAt } }, { createdAt: oldest.createdAt, id: { lt: oldest.id } }] },
      }) : 0;
      return NextResponse.json(page, { headers: { 'X-Earlier-Messages': String(earlier) } });
    }
    const messages = await prisma.message.findMany({
      where: { chatId: id, ...(since ? { createdAt: { gte: since } } : {}) },
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
