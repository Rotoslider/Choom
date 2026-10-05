/**
 * GET /api/hologram/events: Server-Sent Events feed of Choom activity for the Looking Glass
 * hologram (see lib/hologram-bus.ts).
 */
import { subscribeHologram } from '@/lib/hologram-bus';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream({
    start(controller) {
      const write = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };
      write(': connected\n\n');
      const unsubscribe = subscribeHologram((event) => write(`data: ${JSON.stringify(event)}\n\n`));
      const ping = setInterval(() => write(': ping\n\n'), 15000);
      cleanup = () => {
        clearInterval(ping);
        unsubscribe();
      };
      request.signal.addEventListener('abort', () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
