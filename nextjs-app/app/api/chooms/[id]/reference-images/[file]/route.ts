import { NextRequest, NextResponse } from 'next/server';
import { readReferenceImage } from '@/lib/reference-images';

/**
 * GET /api/chooms/[id]/reference-images/[file] — serve one reference image.
 * Used for thumbnails in the Choom edit panel; reference images live in the
 * app's data dir rather than public/, so they need an explicit route.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; file: string }> }
) {
  try {
    const { id, file } = await params;
    const buffer = await readReferenceImage(id, file);
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'image/png',
        // Filenames are content-addressed by upload time and never rewritten.
        'Cache-Control': 'private, max-age=31536000, immutable',
      },
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    console.error('Failed to read reference image:', error);
    return NextResponse.json({ error: 'Failed to read reference image' }, { status: 400 });
  }
}
