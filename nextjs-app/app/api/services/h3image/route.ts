import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/bridge-config-store';
import { h3Health } from '@/lib/h3-image-client';
import type { ImageGenSettings } from '@/lib/types';

// GET /api/services/h3image - the H3 Image server's state, for Settings > Image (its token stays here).
export async function GET() {
  const config = await loadConfig().catch(() => ({} as Record<string, unknown>));
  const imageGen = (config.imageGen || {}) as Partial<ImageGenSettings>;
  return NextResponse.json(await h3Health(imageGen));
}
