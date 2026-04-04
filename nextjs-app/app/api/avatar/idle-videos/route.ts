import { NextRequest, NextResponse } from 'next/server';
import { readdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.join(process.env.HOME || '/home/nuc1', 'choom-projects');
const AVATAR_DIR = path.join(WORKSPACE_ROOT, 'avatar-models');
const CONFIG_FILE = path.join(AVATAR_DIR, 'idle-video-config.json');

async function loadConfig(): Promise<Record<string, string>> {
  try {
    if (existsSync(CONFIG_FILE)) {
      return JSON.parse(await readFile(CONFIG_FILE, 'utf-8'));
    }
  } catch {}
  return {};
}

async function saveConfig(config: Record<string, string>) {
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
}

/**
 * GET /api/avatar/idle-videos?choomId=xxx
 * Scans for idle videos and returns the active one for this choom.
 */
export async function GET(request: NextRequest) {
  const choomId = request.nextUrl.searchParams.get('choomId') || '';

  try {
    if (!existsSync(AVATAR_DIR)) {
      return NextResponse.json({ videos: [], active: null });
    }

    const files = await readdir(AVATAR_DIR);
    // Match any MP4 file that could be an idle video
    const videos = files.filter(f =>
      f.endsWith('.mp4') && (
        f.includes('idle') ||
        f.includes('motion') ||
        f.includes(choomId)
      )
    ).sort();

    const config = await loadConfig();
    const active = config[choomId] || null;

    return NextResponse.json({ videos, active });
  } catch (error) {
    return NextResponse.json({ videos: [], active: null });
  }
}

/**
 * POST /api/avatar/idle-videos
 * Set the active idle video for a choom.
 */
export async function POST(request: NextRequest) {
  try {
    const { choomId, activeVideo } = await request.json();

    const config = await loadConfig();
    if (activeVideo) {
      config[choomId] = activeVideo;
    } else {
      delete config[choomId];
    }
    await saveConfig(config);

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to save config' }, { status: 500 });
  }
}
