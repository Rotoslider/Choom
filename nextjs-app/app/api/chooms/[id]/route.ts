import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import prisma from '@/lib/db';

// GET /api/chooms/[id] - Get a single choom
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const choom = await prisma.choom.findUnique({
      where: { id },
      include: {
        chats: {
          where: { archived: false },
          orderBy: { updatedAt: 'desc' },
        },
      },
    });

    if (!choom) {
      return NextResponse.json(
        { error: 'Choom not found' },
        { status: 404 }
      );
    }

    // Parse JSON fields
    const parsedChoom = {
      ...choom,
      imageSettings: choom.imageSettings ? JSON.parse(choom.imageSettings) : null,
    };

    return NextResponse.json(parsedChoom);
  } catch (error) {
    console.error('Failed to fetch choom:', error);
    return NextResponse.json(
      { error: 'Failed to fetch choom' },
      { status: 500 }
    );
  }
}

// Helper to parse Choom JSON fields
function parseChoomData(choom: Record<string, unknown>) {
  return {
    ...choom,
    imageSettings: choom.imageSettings ? JSON.parse(choom.imageSettings as string) : null,
  };
}

// PUT /api/chooms/[id] - Update a choom
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { name, description, avatarUrl, systemPrompt, voiceId, llmModel, llmEndpoint, llmProviderId, llmTimeoutSec, imageSettings, companionId, llmFallbackModel1, llmFallbackProvider1, llmFallbackModel2, llmFallbackProvider2, avatar3dModelPath, avatar3dStatus, avatar3dError, avatarMode } = body;

    const choom = await prisma.choom.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(avatarUrl !== undefined && { avatarUrl }),
        ...(systemPrompt !== undefined && { systemPrompt }),
        ...(voiceId !== undefined && { voiceId }),
        ...(llmModel !== undefined && { llmModel }),
        ...(llmEndpoint !== undefined && { llmEndpoint }),
        ...(llmProviderId !== undefined && { llmProviderId }),
        ...(llmTimeoutSec !== undefined && { llmTimeoutSec: llmTimeoutSec ? parseInt(llmTimeoutSec, 10) : null }),
        ...(llmFallbackModel1 !== undefined && { llmFallbackModel1 }),
        ...(llmFallbackProvider1 !== undefined && { llmFallbackProvider1 }),
        ...(llmFallbackModel2 !== undefined && { llmFallbackModel2 }),
        ...(llmFallbackProvider2 !== undefined && { llmFallbackProvider2 }),
        ...(companionId !== undefined && { companionId }),
        ...(imageSettings !== undefined && { imageSettings: imageSettings ? JSON.stringify(imageSettings) : null }),
        ...(avatar3dModelPath !== undefined && { avatar3dModelPath }),
        ...(avatar3dStatus !== undefined && { avatar3dStatus }),
        ...(avatar3dError !== undefined && { avatar3dError }),
        ...(avatarMode !== undefined && { avatarMode }),
      },
    });

    // Parse JSON fields before returning
    return NextResponse.json(parseChoomData(choom as unknown as Record<string, unknown>));
  } catch (error) {
    console.error('Failed to update choom:', error);
    return NextResponse.json(
      { error: 'Failed to update choom' },
      { status: 500 }
    );
  }
}

// DELETE /api/chooms/[id] - Delete a choom and all associated data
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const { confirmName } = body as { confirmName?: string };

    const choom = await prisma.choom.findUnique({ where: { id } });
    if (!choom) {
      return NextResponse.json({ error: 'Choom not found' }, { status: 404 });
    }

    if (!confirmName || confirmName !== choom.name) {
      return NextResponse.json(
        { error: 'Confirmation name does not match. Deletion aborted.' },
        { status: 400 }
      );
    }

    const cleaned: Record<string, number> = {};

    // Clean up non-cascading tables
    const activityResult = await prisma.activityLog.deleteMany({ where: { choomId: id } });
    cleaned.activityLogs = activityResult.count;

    const notifResult = await prisma.notification.deleteMany({ where: { choomId: id } });
    cleaned.notifications = notifResult.count;

    const habitResult = await prisma.habitEntry.deleteMany({ where: { choomId: id } });
    cleaned.habitEntries = habitResult.count;

    const tokenResult = await prisma.tokenUsage.deleteMany({ where: { choomId: id } });
    cleaned.tokenUsage = tokenResult.count;

    // Delete the Choom (cascades Chat, Message, GeneratedImage)
    await prisma.choom.delete({ where: { id } });

    // Clean up heartbeat entries in bridge-config.json
    try {
      const configPath = path.join(process.cwd(), 'services', 'signal-bridge', 'bridge-config.json');
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (config.heartbeat?.custom_tasks) {
        const before = config.heartbeat.custom_tasks.length;
        config.heartbeat.custom_tasks = config.heartbeat.custom_tasks.filter(
          (t: { choom_name?: string }) =>
            t.choom_name?.toLowerCase() !== choom.name.toLowerCase()
        );
        cleaned.heartbeats = before - config.heartbeat.custom_tasks.length;
        if (cleaned.heartbeats > 0) {
          writeFileSync(configPath, JSON.stringify(config, null, 2));
        }
      }
    } catch (e) {
      console.warn('Could not clean bridge-config heartbeats:', e);
    }

    return NextResponse.json({ success: true, cleaned });
  } catch (error) {
    console.error('Failed to delete choom:', error);
    return NextResponse.json(
      { error: 'Failed to delete choom' },
      { status: 500 }
    );
  }
}
