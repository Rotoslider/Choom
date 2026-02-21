import { NextRequest, NextResponse } from 'next/server';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { WORKSPACE_ROOT } from '@/lib/config';
const UPLOADS_DIR = 'uploads';
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'];

/** POST — upload an image to the workspace uploads folder */
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json(
        { success: false, error: 'No file provided' },
        { status: 400 }
      );
    }

    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json(
        { success: false, error: `File type ${file.type} not allowed. Supported: PNG, JPEG, GIF, WebP, BMP` },
        { status: 400 }
      );
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { success: false, error: `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum: 10MB` },
        { status: 400 }
      );
    }

    // Sanitize filename
    const ext = path.extname(file.name) || '.png';
    const baseName = file.name
      .replace(ext, '')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 50);
    const timestamp = Date.now();
    const fileName = `${baseName}_${timestamp}${ext}`;

    // Ensure uploads directory exists
    const uploadsPath = path.join(WORKSPACE_ROOT, UPLOADS_DIR);
    await mkdir(uploadsPath, { recursive: true });

    // Write file
    const filePath = path.join(uploadsPath, fileName);
    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(filePath, buffer);

    // Return workspace-relative path
    const relativePath = `${UPLOADS_DIR}/${fileName}`;

    return NextResponse.json({
      success: true,
      path: relativePath,
      fileName,
      size: file.size,
      type: file.type,
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Upload failed' },
      { status: 500 }
    );
  }
}
