import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';

// GET /api/images/[id]/file - Serve the image as binary with proper content-type
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const image = await prisma.generatedImage.findUnique({
      where: { id },
      select: { imageUrl: true },
    });

    if (!image) {
      return new NextResponse('Not found', { status: 404 });
    }

    // Parse data URI: data:<mime>;base64,<data>
    const match = image.imageUrl.match(/^data:([^;]+);base64,(.+)$/s);
    if (!match) {
      // Not a data URI — redirect to the URL directly
      return NextResponse.redirect(image.imageUrl);
    }

    const contentType = match[1];
    const buffer = Buffer.from(match[2], 'base64');

    return new NextResponse(buffer, {
      headers: {
        'Content-Type': contentType,
        'Content-Length': buffer.length.toString(),
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch (error) {
    console.error('Failed to serve image:', error);
    return new NextResponse('Internal Server Error', { status: 500 });
  }
}
