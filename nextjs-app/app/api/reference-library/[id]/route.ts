import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { deleteLibraryImage } from '@/lib/reference-images';

const CATEGORIES = ['character', 'person', 'place', 'object', 'style'];

/** PATCH /api/reference-library/[id] — rename, re-describe, recategorise, enable/disable. */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();

    const data: Record<string, unknown> = {};
    if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim();
    if ('description' in body) {
      data.description = body.description ? String(body.description).slice(0, 500) : null;
    }
    if (CATEGORIES.includes(body.category)) data.category = body.category;
    if ('choomId' in body) data.choomId = body.choomId || null;
    if (typeof body.enabled === 'boolean') data.enabled = body.enabled;

    const subject = await prisma.referenceSubject.update({
      where: { id },
      data,
      include: { images: { orderBy: [{ order: 'asc' }, { createdAt: 'asc' }] } },
    });

    return NextResponse.json({ subject });
  } catch (error) {
    console.error('Failed to update reference subject:', error);
    return NextResponse.json({ error: 'Failed to update reference subject' }, { status: 500 });
  }
}

/** DELETE /api/reference-library/[id] — drop the subject and its image files. */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const subject = await prisma.referenceSubject.findUnique({
      where: { id },
      include: { images: true },
    });
    if (!subject) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    // Files first: a failed row delete would otherwise orphan them silently.
    for (const image of subject.images) {
      await deleteLibraryImage(subject.id, image.file).catch(() => {});
    }
    // Images cascade with the subject.
    await prisma.referenceSubject.delete({ where: { id } });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete reference subject:', error);
    return NextResponse.json({ error: 'Failed to delete reference subject' }, { status: 500 });
  }
}
