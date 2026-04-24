import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import type { ToolCall, ToolResult } from '@/lib/types';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

const TOOL_NAMES = new Set([
  'schedule_self_followup',
  'list_self_followups',
  'cancel_self_followup',
]);

// Queue file (one JSONL per Choom). The bridge scheduler polls these.
const QUEUE_DIR = path.resolve(process.cwd(), 'data', 'self_followups');
const MIN_DELAY_MIN = 5;
const MAX_DELAY_MIN = 30 * 24 * 60; // 30 days
const MAX_PROMPT_CHARS = 1000;
const MAX_PENDING_PER_CHOOM = 10;

interface QueueEntry {
  id: string;
  choom_id: string;
  choom_name: string;
  prompt: string;
  reason: string;
  trigger_at: string; // ISO8601
  created_at: string;
  consumed: boolean;
}

function ensureQueueDir() {
  if (!fs.existsSync(QUEUE_DIR)) {
    fs.mkdirSync(QUEUE_DIR, { recursive: true });
  }
}

function queueFileFor(choomId: string): string {
  const safe = choomId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(QUEUE_DIR, `${safe}.jsonl`);
}

function readQueue(choomId: string): QueueEntry[] {
  const file = queueFileFor(choomId);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
  const out: QueueEntry[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as QueueEntry);
    } catch { /* skip malformed */ }
  }
  return out;
}

function writeQueue(choomId: string, entries: QueueEntry[]): void {
  ensureQueueDir();
  const file = queueFileFor(choomId);
  fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
}

export default class SelfSchedulingHandler extends BaseSkillHandler {
  canHandle(toolName: string): boolean {
    return TOOL_NAMES.has(toolName);
  }

  async execute(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    switch (toolCall.name) {
      case 'schedule_self_followup':
        return this.scheduleFollowup(toolCall, ctx);
      case 'list_self_followups':
        return this.listFollowups(toolCall, ctx);
      case 'cancel_self_followup':
        return this.cancelFollowup(toolCall, ctx);
      default:
        return this.error(toolCall, `Unknown self-scheduling tool: ${toolCall.name}`);
    }
  }

  private async scheduleFollowup(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    const rawDelay = toolCall.arguments.delay_minutes;
    const delay = typeof rawDelay === 'number' ? rawDelay : parseFloat(String(rawDelay));
    const prompt = (toolCall.arguments.prompt as string || '').trim();
    const reason = (toolCall.arguments.reason as string || '').trim();
    const choomName = ((ctx.choom as Record<string, unknown>)?.name as string) || 'unknown';

    if (!Number.isFinite(delay)) {
      return this.error(toolCall, 'delay_minutes must be a number');
    }
    if (!prompt) {
      return this.error(toolCall, 'prompt is required. Provide a short message to your future self — what to check and why.');
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      return this.error(toolCall, `prompt is too long (${prompt.length} chars). Keep it under ${MAX_PROMPT_CHARS}.`);
    }

    const clamped = Math.max(MIN_DELAY_MIN, Math.min(MAX_DELAY_MIN, delay));
    const clampNote = clamped !== delay ? ` (clamped from ${delay} to ${clamped})` : '';

    // Enforce per-Choom queue cap
    const existing = readQueue(ctx.choomId).filter(e => !e.consumed);
    if (existing.length >= MAX_PENDING_PER_CHOOM) {
      const listStr = existing.map(e => `  - ${e.id} at ${e.trigger_at} — "${e.prompt.slice(0, 60)}"`).join('\n');
      return this.error(
        toolCall,
        `You already have ${existing.length} pending self-followups (max ${MAX_PENDING_PER_CHOOM}). Cancel one first with cancel_self_followup, or wait until one fires:\n${listStr}`
      );
    }

    const triggerAt = new Date(Date.now() + clamped * 60 * 1000);
    const entry: QueueEntry = {
      id: `sf_${randomUUID().slice(0, 8)}`,
      choom_id: ctx.choomId,
      choom_name: choomName,
      prompt,
      reason,
      trigger_at: triggerAt.toISOString(),
      created_at: new Date().toISOString(),
      consumed: false,
    };

    const all = readQueue(ctx.choomId);
    all.push(entry);
    writeQueue(ctx.choomId, all);

    console.log(`   ⏰ Self-followup queued for ${choomName}: ${entry.id} at ${entry.trigger_at} — "${prompt.slice(0, 80)}"${clampNote}`);
    return this.success(toolCall, {
      success: true,
      id: entry.id,
      trigger_at: entry.trigger_at,
      delay_minutes: clamped,
      message: `Queued self-followup ${entry.id} for ${entry.trigger_at}${clampNote}. It will fire as a one-shot heartbeat.`,
    });
  }

  private async listFollowups(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    const pending = readQueue(ctx.choomId).filter(e => !e.consumed);
    if (pending.length === 0) {
      return this.success(toolCall, { success: true, followups: [], message: 'No pending self-followups.' });
    }
    return this.success(toolCall, {
      success: true,
      followups: pending.map(e => ({
        id: e.id,
        trigger_at: e.trigger_at,
        prompt: e.prompt.slice(0, 200),
        reason: e.reason,
      })),
    });
  }

  private async cancelFollowup(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    const id = (toolCall.arguments.id as string || '').trim();
    if (!id) return this.error(toolCall, 'id is required. Use list_self_followups to see your pending ids.');

    const all = readQueue(ctx.choomId);
    const idx = all.findIndex(e => e.id === id && !e.consumed);
    if (idx === -1) {
      return this.error(toolCall, `No pending self-followup with id "${id}". Call list_self_followups to see what's queued.`);
    }
    all[idx].consumed = true;
    writeQueue(ctx.choomId, all);
    console.log(`   🗑️  Self-followup cancelled: ${id}`);
    return this.success(toolCall, { success: true, id, message: `Cancelled ${id}.` });
  }
}
