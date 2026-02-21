import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';

// GET /api/logs - Retrieve logs with optional filtering
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const choomId = searchParams.get('choomId');
    const chatId = searchParams.get('chatId');
    const category = searchParams.get('category');
    const level = searchParams.get('level');
    const limit = parseInt(searchParams.get('limit') || '200');

    const where: Record<string, unknown> = {};
    if (choomId) where.choomId = choomId;
    if (chatId) where.chatId = chatId;
    if (category) where.category = category;
    if (level) where.level = level;

    const logs = await prisma.activityLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 500),
    });

    return NextResponse.json(logs);
  } catch (error) {
    console.error('Failed to fetch logs:', error);
    return NextResponse.json({ error: 'Failed to fetch logs' }, { status: 500 });
  }
}

// POST /api/logs - Store a log entry (or batch)
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Support single or batch entries
    const entries = Array.isArray(body) ? body : [body];

    const created = await prisma.activityLog.createMany({
      data: entries.map((entry: {
        choomId?: string;
        chatId?: string;
        level: string;
        category: string;
        title: string;
        message: string;
        details?: string;
        duration?: number;
      }) => ({
        choomId: entry.choomId || null,
        chatId: entry.chatId || null,
        level: entry.level,
        category: entry.category,
        title: entry.title,
        message: entry.message,
        details: entry.details ? (typeof entry.details === 'string' ? entry.details : JSON.stringify(entry.details)) : null,
        duration: entry.duration || null,
      })),
    });

    return NextResponse.json({ created: created.count });
  } catch (error) {
    console.error('Failed to store logs:', error);
    return NextResponse.json({ error: 'Failed to store logs' }, { status: 500 });
  }
}

// DELETE /api/logs - Delete logs by chatId, choomId, or all
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const chatId = searchParams.get('chatId');
    const choomId = searchParams.get('choomId');
    const all = searchParams.get('all');

    const where: Record<string, unknown> = {};
    if (chatId) where.chatId = chatId;
    if (choomId) where.choomId = choomId;

    // If specific filters provided, delete matching logs
    if (chatId || choomId || all === 'true') {
      const result = await prisma.activityLog.deleteMany({
        where: Object.keys(where).length > 0 ? where : undefined,
      });
      return NextResponse.json({ deleted: result.count });
    }

    // Default: delete all logs older than 7 days
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const result = await prisma.activityLog.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    return NextResponse.json({ deleted: result.count });
  } catch (error) {
    console.error('Failed to delete logs:', error);
    return NextResponse.json({ error: 'Failed to delete logs' }, { status: 500 });
  }
}
