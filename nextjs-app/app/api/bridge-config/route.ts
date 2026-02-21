import { NextRequest, NextResponse } from 'next/server';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const CONFIG_PATH = path.join(process.cwd(), 'services/signal-bridge/bridge-config.json');

const DEFAULT_CONFIG = {
  tasks: {
    morning_briefing: { enabled: true, time: '07:00' },
    'weather_check_07:00': { enabled: true, time: '07:00' },
    'weather_check_12:00': { enabled: true, time: '12:00' },
    'weather_check_18:00': { enabled: true, time: '18:00' },
    'aurora_check_12:00': { enabled: true, time: '12:00' },
    'aurora_check_18:00': { enabled: true, time: '18:00' },
    system_health: { enabled: true, interval_minutes: 30 },
    yt_download: { enabled: false, time: '04:00' },
  },
  yt_downloader: {
    max_videos_per_channel: 3,
    channels: [] as { id: string; url: string; name: string; enabled: boolean }[],
  },
  heartbeat: {
    quiet_start: '21:00',
    quiet_end: '06:00',
  },
};

async function loadConfig() {
  try {
    if (existsSync(CONFIG_PATH)) {
      const data = await readFile(CONFIG_PATH, 'utf-8');
      return JSON.parse(data);
    }
    // Create default config
    await writeFile(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return DEFAULT_CONFIG;
  } catch {
    return DEFAULT_CONFIG;
  }
}

// GET /api/bridge-config - Read bridge config
export async function GET() {
  try {
    const config = await loadConfig();
    return NextResponse.json(config);
  } catch (error) {
    console.error('Failed to read bridge config:', error);
    return NextResponse.json(
      { error: 'Failed to read bridge config' },
      { status: 500 }
    );
  }
}

// POST /api/bridge-config - Update bridge config
export async function POST(request: NextRequest) {
  try {
    const updates = await request.json();
    const current = await loadConfig();

    // Deep merge updates into current config
    const merged = deepMerge(current, updates);
    await writeFile(CONFIG_PATH, JSON.stringify(merged, null, 2));

    return NextResponse.json(merged);
  } catch (error) {
    console.error('Failed to update bridge config:', error);
    return NextResponse.json(
      { error: 'Failed to update bridge config' },
      { status: 500 }
    );
  }
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (
      result[key] &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key]) &&
      typeof override[key] === 'object' &&
      !Array.isArray(override[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        override[key] as Record<string, unknown>
      );
    } else {
      result[key] = override[key];
    }
  }
  return result;
}
