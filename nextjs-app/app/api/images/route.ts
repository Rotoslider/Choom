import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';

// GET /api/images - Get images for a choom
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const choomId = searchParams.get('choomId');

    if (!choomId) {
      return NextResponse.json(
        { error: 'choomId is required' },
        { status: 400 }
      );
    }

    const images = await prisma.generatedImage.findMany({
      where: { choomId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        choomId: true,
        prompt: true,
        settings: true,
        createdAt: true,
        // imageUrl excluded — too large for bulk fetch (base64 data URIs).
        // Individual images served via /api/images/[id]/file
      },
    });

    return NextResponse.json(images);
  } catch (error) {
    console.error('Failed to fetch images:', error);
    return NextResponse.json(
      { error: 'Failed to fetch images' },
      { status: 500 }
    );
  }
}
