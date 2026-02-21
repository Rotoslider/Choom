import { NextRequest, NextResponse } from 'next/server';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const CONFIG_PATH = path.join(process.cwd(), 'services/signal-bridge/bridge-config.json');

async function loadConfig() {
  try {
    if (existsSync(CONFIG_PATH)) {
      const data = await readFile(CONFIG_PATH, 'utf-8');
      return JSON.parse(data);
    }
    return {};
  } catch {
    return {};
  }
}

async function saveConfig(config: Record<string, unknown>) {
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// GET /api/reminders - List pending reminders
export async function GET() {
  try {
    const config = await loadConfig();
    const reminders = config.reminders || [];
    return NextResponse.json(reminders);
  } catch (error) {
    console.error('Failed to read reminders:', error);
    return NextResponse.json({ error: 'Failed to read reminders' }, { status: 500 });
  }
}

// POST /api/reminders - Create a new reminder
// Body: { id, text, remind_at }
// Writes to bridge-config.json in the same format as task_config.py:add_reminder()
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, text, remind_at } = body;

    if (!id || !text || !remind_at) {
      return NextResponse.json({ error: 'Missing required fields: id, text, remind_at' }, { status: 400 });
    }

    const config = await loadConfig();
    if (!config.reminders) {
      config.reminders = [];
    }

    config.reminders.push({
      id,
      text,
      remind_at,
      created_at: new Date().toISOString(),
    });

    await saveConfig(config);

    console.log(`⏰ Reminder created: "${text}" at ${remind_at}`);
    return NextResponse.json({ success: true, id });
  } catch (error) {
    console.error('Failed to create reminder:', error);
    return NextResponse.json({ error: 'Failed to create reminder' }, { status: 500 });
  }
}

// DELETE /api/reminders?id=xxx - Remove a reminder
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ error: 'Missing id parameter' }, { status: 400 });
    }

    const config = await loadConfig();
    const reminders = config.reminders || [];
    config.reminders = reminders.filter((r: { id: string }) => r.id !== id);
    await saveConfig(config);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete reminder:', error);
    return NextResponse.json({ error: 'Failed to delete reminder' }, { status: 500 });
  }
}
