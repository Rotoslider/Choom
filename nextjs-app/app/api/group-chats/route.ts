import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import prisma from '@/lib/db';
import { WORKSPACE_ROOT } from '@/lib/config';
import { getOwnerIdentity } from '@/lib/owner';

// GET /api/group-chats - List rooms (newest first)
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const includeArchived = searchParams.get('archived') === 'true';
    const rooms = await prisma.groupRoom.findMany({
      where: { ...(!includeArchived && { archived: false }) },
      include: {
        participants: { include: { choom: true }, orderBy: { order: 'asc' } },
        _count: { select: { messages: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });
    return NextResponse.json(rooms);
  } catch (error) {
    console.error('Failed to fetch group rooms:', error);
    return NextResponse.json({ error: 'Failed to fetch group rooms' }, { status: 500 });
  }
}

// POST /api/group-chats - Create a room
// Body: { title?, autoRounds?, participants: [{ choomId, order? }] | string[] }
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { title, autoRounds } = body;
    const rawParticipants = body.participants;

    if (!Array.isArray(rawParticipants) || rawParticipants.length < 1) {
      return NextResponse.json({ error: 'participants (≥1) are required' }, { status: 400 });
    }

    // Normalize participants to { choomId, order }
    const participants = rawParticipants.map((p: unknown, i: number) =>
      typeof p === 'string'
        ? { choomId: p, order: i }
        : { choomId: (p as { choomId: string }).choomId, order: (p as { order?: number }).order ?? i }
    );

    // Verify all chooms exist
    const chooms = await prisma.choom.findMany({ where: { id: { in: participants.map(p => p.choomId) } } });
    if (chooms.length !== participants.length) {
      return NextResponse.json({ error: 'One or more chooms not found' }, { status: 404 });
    }

    // Create the room first so we can suffix its folder with the unique room id
    // — otherwise two rooms with the same title/participants would share (and
    // overwrite) the same folder on disk.
    const room = await prisma.groupRoom.create({
      data: {
        title: title || null,
        autoRounds: typeof autoRounds === 'number' ? Math.max(0, Math.min(50, autoRounds)) : 0,
        participants: {
          create: participants.map(p => ({ choomId: p.choomId, order: p.order, active: true })),
        },
      },
      include: { participants: { include: { choom: true }, orderBy: { order: 'asc' } } },
    });

    // Shared room workspace folder under choom_commons/ (contractGate already
    // permits all participants to write there). Suffixed with the room id so it
    // is unique even for identically-named rooms.
    const slugBase = (title || chooms.map(c => c.name).join('-'))
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'room';
    const projectFolder = `choom_commons/rooms/${slugBase}-${room.id.slice(-6)}`;
    try {
      fs.mkdirSync(path.join(WORKSPACE_ROOT, projectFolder), { recursive: true });
    } catch (e) {
      console.warn('Could not pre-create room folder:', (e as Error).message);
    }
    const updated = await prisma.groupRoom.update({
      where: { id: room.id },
      data: { projectFolder },
      include: { participants: { include: { choom: true }, orderBy: { order: 'asc' } } },
    });

    // Provenance: the owner created this room from the /rooms UI.
    await prisma.activityLog.create({
      data: {
        choomId: null, chatId: room.id, level: 'info', category: 'system',
        title: 'Room created', message: `Created by ${getOwnerIdentity().name}.`,
      },
    }).catch(() => { /* logging is best-effort */ });

    return NextResponse.json(updated, { status: 201 });
  } catch (error) {
    console.error('Failed to create group room:', error);
    return NextResponse.json({ error: 'Failed to create group room' }, { status: 500 });
  }
}
