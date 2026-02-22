import { NextRequest, NextResponse } from 'next/server';
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
    const { name, description, avatarUrl, systemPrompt, voiceId, llmModel, llmEndpoint, llmProviderId, imageSettings, companionId } = body;

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
        ...(companionId !== undefined && { companionId }),
        ...(imageSettings !== undefined && { imageSettings: imageSettings ? JSON.stringify(imageSettings) : null }),
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

// DELETE /api/chooms/[id] - Delete a choom
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await prisma.choom.delete({
      where: { id },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete choom:', error);
    return NextResponse.json(
      { error: 'Failed to delete choom' },
      { status: 500 }
    );
  }
}
