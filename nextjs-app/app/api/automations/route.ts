import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';

const BRIDGE_CONFIG_PATH = path.join(process.cwd(), 'services/signal-bridge/bridge-config.json');

// ============================================================================
// Types
// ============================================================================

interface AutomationStep {
  id: string;
  skillName: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

interface AutomationSchedule {
  type: 'cron' | 'interval';
  cron?: string;
  hour?: number;
  minute?: number;
  daysOfWeek?: number[];
  intervalMinutes?: number;
}

interface Automation {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  schedule: AutomationSchedule;
  choomName: string;
  respectQuiet: boolean;
  notifyOnComplete: boolean;
  steps: AutomationStep[];
  lastRun?: string;
  lastResult?: 'success' | 'partial' | 'failed';
}

// ============================================================================
// Helpers
// ============================================================================

function loadConfig(): Record<string, unknown> {
  try {
    if (existsSync(BRIDGE_CONFIG_PATH)) {
      const data = readFileSync(BRIDGE_CONFIG_PATH, 'utf-8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('[Automations API] Failed to read bridge config:', err);
  }
  return {};
}

function saveConfig(config: Record<string, unknown>): void {
  writeFileSync(BRIDGE_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

function getAutomations(config: Record<string, unknown>): Automation[] {
  return (config.automations as Automation[]) || [];
}

/**
 * Build a cron expression from the schedule fields.
 * Format: minute hour * * daysOfWeek
 */
function buildCronExpression(schedule: AutomationSchedule): string {
  if (schedule.cron) return schedule.cron;
  if (schedule.type === 'interval') {
    // Interval-based: use */N minute pattern
    const mins = schedule.intervalMinutes || 60;
    return `*/${mins} * * * *`;
  }
  // Cron-based from structured fields
  const minute = schedule.minute ?? 0;
  const hour = schedule.hour ?? 0;
  const days = schedule.daysOfWeek;
  const dayStr = days && days.length > 0 && days.length < 7
    ? days.join(',')
    : '*';
  return `${minute} ${hour} * * ${dayStr}`;
}

// ============================================================================
// GET /api/automations — List all automations
// ============================================================================

export async function GET() {
  try {
    const config = loadConfig();
    const automations = getAutomations(config);
    return NextResponse.json({ success: true, automations });
  } catch (error) {
    console.error('[Automations API] GET error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

// ============================================================================
// POST /api/automations — Create automation OR trigger one
// ============================================================================

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Handle "Run Now" trigger action
    if (body.action === 'trigger' && body.automationId) {
      return handleTrigger(body.automationId);
    }

    // Otherwise, create a new automation
    return handleCreate(body);
  } catch (error) {
    console.error('[Automations API] POST error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

function handleTrigger(automationId: string): NextResponse {
  const config = loadConfig();
  const automations = getAutomations(config);
  const automation = automations.find((a) => a.id === automationId);

  if (!automation) {
    return NextResponse.json(
      { success: false, error: `Automation ${automationId} not found` },
      { status: 404 }
    );
  }

  // Add to pending_triggers for the bridge to pick up
  if (!config.pending_triggers) {
    config.pending_triggers = [];
  }

  const triggers = config.pending_triggers as Array<{ taskId: string }>;
  const exists = triggers.some((t) => t.taskId === automationId);

  if (!exists) {
    triggers.push({
      taskId: automationId,
      taskType: 'automation',
      triggeredAt: new Date().toISOString(),
    } as unknown as { taskId: string });
  }

  saveConfig(config);

  return NextResponse.json({
    success: true,
    message: `Triggered automation "${automation.name}"`,
  });
}

function handleCreate(body: Record<string, unknown>): NextResponse {
  const { name, description, schedule, choomName, steps, respectQuiet, notifyOnComplete } = body;

  if (!name || typeof name !== 'string') {
    return NextResponse.json(
      { success: false, error: 'Automation name is required' },
      { status: 400 }
    );
  }

  if (!Array.isArray(steps) || steps.length === 0) {
    return NextResponse.json(
      { success: false, error: 'At least one step is required' },
      { status: 400 }
    );
  }

  if (!schedule || typeof schedule !== 'object') {
    return NextResponse.json(
      { success: false, error: 'Schedule configuration is required' },
      { status: 400 }
    );
  }

  const config = loadConfig();
  const automations = getAutomations(config);

  const sched = schedule as AutomationSchedule;
  const automation: Automation = {
    id: `auto_${Date.now()}`,
    name: name as string,
    description: (description as string) || '',
    enabled: true,
    schedule: {
      ...sched,
      cron: buildCronExpression(sched),
    },
    choomName: (choomName as string) || 'Choom',
    respectQuiet: respectQuiet !== false,
    notifyOnComplete: notifyOnComplete !== false,
    steps: (steps as AutomationStep[]).map((s, i) => ({
      ...s,
      id: s.id || `step_${Date.now()}_${i}`,
    })),
  };

  automations.push(automation);
  config.automations = automations;
  saveConfig(config);

  return NextResponse.json({ success: true, automation }, { status: 201 });
}

// ============================================================================
// PUT /api/automations — Update an existing automation
// ============================================================================

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, ...updates } = body;

    if (!id || typeof id !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Automation id is required' },
        { status: 400 }
      );
    }

    const config = loadConfig();
    const automations = getAutomations(config);
    const index = automations.findIndex((a) => a.id === id);

    if (index === -1) {
      return NextResponse.json(
        { success: false, error: `Automation ${id} not found` },
        { status: 404 }
      );
    }

    // Merge updates
    const existing = automations[index];
    const updated: Automation = { ...existing };

    if (updates.name !== undefined) updated.name = updates.name;
    if (updates.description !== undefined) updated.description = updates.description;
    if (updates.enabled !== undefined) updated.enabled = updates.enabled;
    if (updates.choomName !== undefined) updated.choomName = updates.choomName;
    if (updates.respectQuiet !== undefined) updated.respectQuiet = updates.respectQuiet;
    if (updates.notifyOnComplete !== undefined) updated.notifyOnComplete = updates.notifyOnComplete;

    if (updates.schedule) {
      const sched = updates.schedule as AutomationSchedule;
      updated.schedule = {
        ...sched,
        cron: buildCronExpression(sched),
      };
    }

    if (updates.steps) {
      updated.steps = (updates.steps as AutomationStep[]).map((s, i) => ({
        ...s,
        id: s.id || `step_${Date.now()}_${i}`,
      }));
    }

    automations[index] = updated;
    config.automations = automations;
    saveConfig(config);

    return NextResponse.json({ success: true, automation: updated });
  } catch (error) {
    console.error('[Automations API] PUT error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

// ============================================================================
// DELETE /api/automations — Delete an automation
// ============================================================================

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json(
        { success: false, error: 'Automation id is required as query parameter' },
        { status: 400 }
      );
    }

    const config = loadConfig();
    const automations = getAutomations(config);
    const index = automations.findIndex((a) => a.id === id);

    if (index === -1) {
      return NextResponse.json(
        { success: false, error: `Automation ${id} not found` },
        { status: 404 }
      );
    }

    const removed = automations.splice(index, 1)[0];
    config.automations = automations;
    saveConfig(config);

    return NextResponse.json({
      success: true,
      message: `Deleted automation "${removed.name}"`,
    });
  } catch (error) {
    console.error('[Automations API] DELETE error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
