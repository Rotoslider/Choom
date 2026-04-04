import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { markGpuBusy, markGpuFree } from '@/lib/gpu-lock';

const AVATAR_SERVICE_URL = process.env.AVATAR_SERVICE_URL || 'http://127.0.0.1:8020';

/**
 * POST /api/avatar/generate
 *
 * Triggers 3D avatar generation for a Choom.
 * Returns an SSE stream with progress updates.
 */
export async function POST(request: NextRequest) {
  try {
    const { choomId, regenerate } = await request.json();

    if (!choomId) {
      return NextResponse.json({ error: 'choomId is required' }, { status: 400 });
    }

    // Fetch Choom and its avatar image
    const choom = await prisma.choom.findUnique({ where: { id: choomId } });
    if (!choom) {
      return NextResponse.json({ error: 'Choom not found' }, { status: 404 });
    }
    if (!choom.avatarUrl) {
      return NextResponse.json({ error: 'Choom has no avatar image' }, { status: 400 });
    }

    // Mark GPU busy
    markGpuBusy('3D avatar generation');

    // Update status to generating
    await prisma.choom.update({
      where: { id: choomId },
      data: { avatar3dStatus: 'generating', avatar3dError: null },
    });

    // Start generation on the avatar service
    const endpoint = regenerate ? '/regenerate' : '/generate';
    const genResponse = await fetch(`${AVATAR_SERVICE_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        choom_id: choomId,
        image_base64: choom.avatarUrl,
      }),
    });

    if (!genResponse.ok) {
      markGpuFree();
      const error = await genResponse.text();
      await prisma.choom.update({
        where: { id: choomId },
        data: { avatar3dStatus: 'failed', avatar3dError: error },
      });
      return NextResponse.json({ error: `Avatar service error: ${error}` }, { status: 500 });
    }

    const { job_id } = await genResponse.json();

    // Return SSE stream that polls for progress
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const send = (data: Record<string, unknown>) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        };

        try {
          let completed = false;
          while (!completed) {
            await new Promise((r) => setTimeout(r, 2000));

            try {
              const statusRes = await fetch(`${AVATAR_SERVICE_URL}/status/${job_id}`);
              if (!statusRes.ok) {
                send({ type: 'error', message: 'Failed to check status' });
                break;
              }

              const status = await statusRes.json();
              send({
                type: 'progress',
                step: status.step,
                percent: status.percent,
                status: status.status,
              });

              if (status.status === 'completed') {
                // Update database with model path
                await prisma.choom.update({
                  where: { id: choomId },
                  data: {
                    avatar3dStatus: 'ready',
                    avatar3dModelPath: status.output_path,
                    avatar3dError: null,
                  },
                });

                send({ type: 'done', modelPath: status.output_path });
                completed = true;
              } else if (status.status === 'failed') {
                await prisma.choom.update({
                  where: { id: choomId },
                  data: {
                    avatar3dStatus: 'failed',
                    avatar3dError: status.error || 'Unknown error',
                  },
                });

                send({ type: 'error', message: status.error || 'Generation failed' });
                completed = true;
              }
            } catch (pollError) {
              console.error('[Avatar] Poll error:', pollError);
              send({ type: 'error', message: 'Connection to avatar service lost' });
              completed = true;
            }
          }
        } finally {
          markGpuFree();
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    markGpuFree();
    console.error('[Avatar] Generation error:', error);
    return NextResponse.json(
      { error: 'Failed to start avatar generation' },
      { status: 500 }
    );
  }
}
