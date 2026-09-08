import { NextRequest, NextResponse } from 'next/server';
import {
  saveReferenceImage,
  deleteReferenceImage,
  listReferenceFiles,
} from '@/lib/reference-images';
import { REFERENCE_IMAGE_MAX_UPLOAD_BYTES } from '@/lib/config';

const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/gif'];

/**
 * POST /api/chooms/[id]/reference-images — upload one reference image.
 *
 * Returns the ReferenceImage descriptor to append to the Choom's imageSettings.
 * The descriptor is NOT persisted here: the edit panel saves it with the rest of
 * the image settings, so an abandoned dialog leaves at most an orphan file.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const label = (formData.get('label') as string | null) || undefined;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }
    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json(
        { error: `File type ${file.type} not allowed. Supported: PNG, JPEG, WebP, BMP, GIF` },
        { status: 400 }
      );
    }
    if (file.size > REFERENCE_IMAGE_MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        {
          error: `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum: ${
            REFERENCE_IMAGE_MAX_UPLOAD_BYTES / 1024 / 1024
          }MB`,
        },
        { status: 400 }
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const reference = await saveReferenceImage(id, buffer, label ?? file.name);

    return NextResponse.json({ reference });
  } catch (error) {
    console.error('Failed to save reference image:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to save reference image' },
      { status: 500 }
    );
  }
}

/** GET /api/chooms/[id]/reference-images — filenames present on disk. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    return NextResponse.json({ files: await listReferenceFiles(id) });
  } catch (error) {
    console.error('Failed to list reference images:', error);
    return NextResponse.json({ error: 'Failed to list reference images', files: [] }, { status: 500 });
  }
}

/** DELETE /api/chooms/[id]/reference-images?file=<name> */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const file = new URL(request.url).searchParams.get('file');
    if (!file) {
      return NextResponse.json({ error: 'file query param required' }, { status: 400 });
    }
    await deleteReferenceImage(id, file);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete reference image:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete reference image' },
      { status: 500 }
    );
  }
}
