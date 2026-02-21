import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';

// Helper to parse Choom JSON fields
function parseChoomData(choom: Record<string, unknown>) {
  return {
    ...choom,
    imageSettings: choom.imageSettings ? JSON.parse(choom.imageSettings as string) : null,
  };
}

// GET /api/chooms - List all chooms
export async function GET() {
  try {
    const chooms = await prisma.choom.findMany({
      orderBy: { createdAt: 'desc' },
    });
    // Parse JSON fields for each choom
    const parsedChooms = chooms.map((c) => parseChoomData(c as unknown as Record<string, unknown>));
    return NextResponse.json(parsedChooms);
  } catch (error) {
    console.error('Failed to fetch chooms:', error);
    return NextResponse.json(
      { error: 'Failed to fetch chooms' },
      { status: 500 }
    );
  }
}

// POST /api/chooms - Create a new choom
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, description, avatarUrl, systemPrompt, voiceId, llmModel, llmEndpoint, imageSettings, companionId } = body;

    if (!name) {
      return NextResponse.json(
        { error: 'Name is required' },
        { status: 400 }
      );
    }

    const choom = await prisma.choom.create({
      data: {
        name,
        description: description || null,
        avatarUrl: avatarUrl || null,
        systemPrompt: systemPrompt || '',
        voiceId: voiceId || null,
        llmModel: llmModel || null,
        llmEndpoint: llmEndpoint || null,
        companionId: companionId || null,
        imageSettings: imageSettings ? JSON.stringify(imageSettings) : null,
      },
    });

    // Parse JSON fields before returning
    return NextResponse.json(parseChoomData(choom as unknown as Record<string, unknown>), { status: 201 });
  } catch (error) {
    console.error('Failed to create choom:', error);
    return NextResponse.json(
      { error: 'Failed to create choom' },
      { status: 500 }
    );
  }
}
