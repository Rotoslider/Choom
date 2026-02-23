import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';

/**
 * POST /api/notifications — Queue a notification for delivery via Signal bridge
 * Body: { choomId, message, includeAudio? }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { choomId, message, includeAudio, imageIds } = body;

    if (!choomId || !message) {
      return NextResponse.json({ error: 'choomId and message are required' }, { status: 400 });
    }

    const notification = await prisma.notification.create({
      data: {
        choomId,
        message,
        includeAudio: includeAudio !== false,
        imageIds: Array.isArray(imageIds) && imageIds.length > 0 ? JSON.stringify(imageIds) : null,
      },
    });

    return NextResponse.json(notification, { status: 201 });
  } catch (error) {
    console.error('Notification POST error:', error);
    return NextResponse.json({ error: 'Failed to create notification' }, { status: 500 });
  }
}

/**
 * GET /api/notifications — Fetch undelivered notifications (for bridge polling)
 * Resolves imageIds into base64 image data for Signal delivery
 */
export async function GET() {
  try {
    const notifications = await prisma.notification.findMany({
      where: { delivered: false },
      orderBy: { createdAt: 'asc' },
    });

    // Resolve image IDs to base64 data
    const enriched = await Promise.all(
      notifications.map(async (notif) => {
        const result: Record<string, unknown> = { ...notif };

        if (notif.imageIds) {
          try {
            const ids = JSON.parse(notif.imageIds) as string[];
            if (ids.length > 0) {
              const images = await prisma.generatedImage.findMany({
                where: { id: { in: ids } },
                select: { id: true, imageUrl: true },
              });
              result.images = images.map((img) => ({
                id: img.id,
                url: img.imageUrl,
              }));
            }
          } catch {
            // Invalid JSON in imageIds — skip
          }
        }

        return result;
      })
    );

    return NextResponse.json(enriched);
  } catch (error) {
    console.error('Notification GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch notifications' }, { status: 500 });
  }
}

/**
 * DELETE /api/notifications — Mark notifications as delivered
 * Body: { ids: string[] }
 */
export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json();
    const { ids } = body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ error: 'ids array is required' }, { status: 400 });
    }

    await prisma.notification.updateMany({
      where: { id: { in: ids } },
      data: { delivered: true },
    });

    return NextResponse.json({ success: true, count: ids.length });
  } catch (error) {
    console.error('Notification DELETE error:', error);
    return NextResponse.json({ error: 'Failed to mark notifications delivered' }, { status: 500 });
  }
}
