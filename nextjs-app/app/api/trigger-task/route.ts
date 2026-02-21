import { NextRequest, NextResponse } from 'next/server';
import { readFile, writeFile } from 'fs/promises';
import path from 'path';

const BRIDGE_CONFIG_PATH = path.join(process.cwd(), 'services/signal-bridge/bridge-config.json');

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { taskId, taskType } = body;

    if (!taskId || !taskType) {
      return NextResponse.json(
        { success: false, error: 'taskId and taskType are required' },
        { status: 400 }
      );
    }

    // Valid task types
    const validTypes = ['cron', 'heartbeat'];
    if (!validTypes.includes(taskType)) {
      return NextResponse.json(
        { success: false, error: `Invalid taskType. Must be one of: ${validTypes.join(', ')}` },
        { status: 400 }
      );
    }

    // Read current config
    const raw = await readFile(BRIDGE_CONFIG_PATH, 'utf-8');
    const config = JSON.parse(raw);

    // Add trigger
    if (!config.pending_triggers) {
      config.pending_triggers = [];
    }

    // Prevent duplicate triggers
    const exists = config.pending_triggers.some(
      (t: { taskId: string }) => t.taskId === taskId
    );
    if (exists) {
      return NextResponse.json({ success: true, message: 'Trigger already pending' });
    }

    config.pending_triggers.push({
      taskId,
      taskType,
      triggeredAt: new Date().toISOString(),
    });

    await writeFile(BRIDGE_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');

    return NextResponse.json({ success: true, message: `Triggered ${taskId}` });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
