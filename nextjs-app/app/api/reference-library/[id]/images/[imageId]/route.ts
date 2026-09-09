import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { readLibraryImage, deleteLibraryImage } from '@/lib/reference-images';

/** GET — serve the image bytes (library images live outside public/). */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; imageId: string }> }
) {
  try {
    const { id, imageId } = await params;
    const image = await prisma.referenceSubjectImage.findUnique({ where: { id: imageId } });
    if (!image || image.subjectId !== id) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const buffer = await readLibraryImage(id, image.file);
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'private, max-age=31536000, immutable',
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    console.error('Failed to read library image:', error);
    return NextResponse.json({ error: 'Failed to read library image' }, { status: 400 });
  }
}

/** PATCH — toggle an image on/off or relabel it. */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; imageId: string }> }
) {
  try {
    const { id, imageId } = await params;
    const body = await request.json();

    const existing = await prisma.referenceSubjectImage.findUnique({ where: { id: imageId } });
    if (!existing || existing.subjectId !== id) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const data: Record<string, unknown> = {};
    if (typeof body.enabled === 'boolean') data.enabled = body.enabled;
    if (typeof body.label === 'string') data.label = body.label.slice(0, 80) || null;

    const image = await prisma.referenceSubjectImage.update({ where: { id: imageId }, data });
    return NextResponse.json({ image });
  } catch (error) {
    console.error('Failed to update library image:', error);
    return NextResponse.json({ error: 'Failed to update library image' }, { status: 500 });
  }
}

/** DELETE — remove one image from a subject. */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; imageId: string }> }
) {
  try {
    const { id, imageId } = await params;
    const image = await prisma.referenceSubjectImage.findUnique({ where: { id: imageId } });
    if (!image || image.subjectId !== id) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    await deleteLibraryImage(id, image.file).catch(() => {});
    await prisma.referenceSubjectImage.delete({ where: { id: imageId } });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete library image:', error);
    return NextResponse.json({ error: 'Failed to delete library image' }, { status: 500 });
  }
}
