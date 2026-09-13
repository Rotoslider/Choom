import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { parseDataUri } from '@/lib/data-uri';

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

    // Parse data URI: data:<mime>;base64,<data> — WITHOUT a regex over the
    // payload. `/^data:([^;]+);base64,([\s\S]+)$/` threw "Maximum call stack
    // size exceeded" on a 6.4 MB PNG (xx-large single-pass portraits), so the
    // gallery and the chat showed the prompt text where the image should be
    // while Signal, which decodes the base64 itself, delivered it fine
    // (2026-09-13). Camera JPEGs under 1 MB never hit it.
    const parsed = parseDataUri(image.imageUrl);
    if (!parsed) {
      // Not a data URI — redirect to the URL directly
      return NextResponse.redirect(image.imageUrl);
    }

    const contentType = parsed.contentType;
    const buffer = parsed.buffer;

    return new NextResponse(new Uint8Array(buffer), {
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
