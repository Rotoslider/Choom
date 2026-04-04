import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.join(process.env.HOME || '/home/nuc1', 'choom-projects');

/**
 * GET /api/avatar/[choomId]/model
 *
 * Serves the GLB 3D model file for a Choom's avatar.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ choomId: string }> }
) {
  try {
    const { choomId } = await params;

    // Look up the Choom's model path
    const choom = await prisma.choom.findUnique({
      where: { id: choomId },
      select: { avatar3dModelPath: true, avatar3dStatus: true },
    });

    if (!choom || choom.avatar3dStatus !== 'ready' || !choom.avatar3dModelPath) {
      return NextResponse.json(
        { error: 'No 3D avatar model available' },
        { status: 404 }
      );
    }

    // Resolve full path
    const modelPath = path.join(WORKSPACE_ROOT, choom.avatar3dModelPath);

    if (!existsSync(modelPath)) {
      // Model file missing on disk — mark as failed
      await prisma.choom.update({
        where: { id: choomId },
        data: {
          avatar3dStatus: 'failed',
          avatar3dError: 'Model file not found on disk',
        },
      });
      return NextResponse.json(
        { error: 'Model file not found' },
        { status: 404 }
      );
    }

    // Read and serve the GLB file
    const glbData = await readFile(modelPath);

    return new Response(glbData, {
      headers: {
        'Content-Type': 'model/gltf-binary',
        'Cache-Control': 'no-cache',
        'Content-Length': glbData.byteLength.toString(),
      },
    });
  } catch (error) {
    console.error('[Avatar] Model serve error:', error);
    return NextResponse.json(
      { error: 'Failed to serve avatar model' },
      { status: 500 }
    );
  }
}
