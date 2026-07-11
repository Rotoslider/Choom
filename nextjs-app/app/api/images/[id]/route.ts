import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';

// DELETE /api/images/[id] - Delete an image
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    await prisma.generatedImage.delete({
      where: { id },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete image:', error);
    return NextResponse.json(
      { error: 'Failed to delete image' },
      { status: 500 }
    );
  }
}

// GET /api/images/[id] - Get a single image.
// With ?meta=1, imageUrl (a multi-MB base64 data URI) is excluded — the
// binary is served by /api/images/[id]/file. The chat UI uses ?meta=1; the
// full response stays the default because the Signal bridge's image-delivery
// fallback (bridge.py) reads imageUrl from this route.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const metaOnly = request.nextUrl.searchParams.has('meta');

    const image = await prisma.generatedImage.findUnique({
      where: { id },
      ...(metaOnly && {
        select: {
          id: true,
          choomId: true,
          prompt: true,
          settings: true,
          createdAt: true,
        },
      }),
    });

    if (!image) {
      return NextResponse.json(
        { error: 'Image not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(image);
  } catch (error) {
    console.error('Failed to fetch image:', error);
    return NextResponse.json(
      { error: 'Failed to fetch image' },
      { status: 500 }
    );
  }
}
