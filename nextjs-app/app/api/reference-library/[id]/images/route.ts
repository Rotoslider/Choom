import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { saveLibraryImage } from '@/lib/reference-images';
import { REFERENCE_IMAGE_MAX_UPLOAD_BYTES } from '@/lib/config';

const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/gif'];
const KINDS = ['sheet', 'face', 'extra'];

/**
 * POST /api/reference-library/[id]/images — add an image to a subject.
 *
 * `kind` orders what Forge receives: sheet (0) before face (1) before extra (2),
 * because reference order is meaningful and the sheet should lead.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const subject = await prisma.referenceSubject.findUnique({ where: { id } });
    if (!subject) {
      return NextResponse.json({ error: 'Subject not found' }, { status: 404 });
    }

    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const kindRaw = String(formData.get('kind') || 'sheet');
    const kind = KINDS.includes(kindRaw) ? kindRaw : 'sheet';

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }
    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json({ error: `File type ${file.type} not allowed` }, { status: 400 });
    }
    if (file.size > REFERENCE_IMAGE_MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB)` },
        { status: 400 }
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const stored = await saveLibraryImage(subject.id, buffer, file.name);

    const image = await prisma.referenceSubjectImage.create({
      data: {
        subjectId: subject.id,
        file: stored.file,
        label: stored.label || null,
        kind,
        order: KINDS.indexOf(kind),
        width: stored.width ?? null,
        height: stored.height ?? null,
      },
    });

    return NextResponse.json({ image });
  } catch (error) {
    console.error('Failed to add reference image:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to add reference image' },
      { status: 500 }
    );
  }
}
