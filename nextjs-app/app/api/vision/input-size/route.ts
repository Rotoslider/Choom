/**
 * GET /api/vision/input-size?model=<id>: how many pixels that vision model looks at, read from its
 * files in LM Studio's models folder (lib/vision-input-size.ts); size is null when it can't be read.
 */
import { NextResponse } from 'next/server';
import { visionInputSize } from '@/lib/vision-input-size';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const model = new URL(request.url).searchParams.get('model') || '';
  return NextResponse.json({ model, size: model ? await visionInputSize(model) : null });
}
