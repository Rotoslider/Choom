import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import type { ToolCall, ToolResult } from '@/lib/types';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
  QUEUE_ROOT,
  type Bucket,
  type QueueEntry,
  bucketDir,
  entryPath,
  atomicWriteJson,
  atomicMove,
  listEntries,
  migrateLegacyJsonl,
} from '@/lib/self-followup-store';

const TOOL_NAMES = new Set([
  'schedule_self_followup',
  'list_self_followups',
  'cancel_self_followup',
]);

const MIN_DELAY_MIN = 5;
const MAX_DELAY_MIN = 30 * 24 * 60; // 30 days
const MAX_PROMPT_CHARS = 2000;
const MAX_PENDING_PER_CHOOM = 100;

export default class SelfSchedulingHandler extends BaseSkillHandler {
  canHandle(toolName: string): boolean {
    return TOOL_NAMES.has(toolName);
  }

  async execute(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    migrateLegacyJsonl();
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

    // Per-Choom cap: count files currently in pending/
    const pendingCount = listEntries(ctx.choomId, 'pending').length;
    if (pendingCount >= MAX_PENDING_PER_CHOOM) {
      const sample = listEntries(ctx.choomId, 'pending')
        .slice(0, 10)
        .map(e => `  - ${e.id} at ${e.trigger_at} — "${e.prompt.slice(0, 60)}"`).join('\n');
      return this.error(
        toolCall,
        `You already have ${pendingCount} pending self-followups (max ${MAX_PENDING_PER_CHOOM}). Cancel one first with cancel_self_followup, or wait until one fires:\n${sample}`
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
      status: 'pending',
    };

    atomicWriteJson(entryPath(ctx.choomId, 'pending', entry.id), entry);

    const userTz = 'America/Denver';
    const triggerLocal = triggerAt.toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
      timeZone: userTz,
    });

    console.log(`   ⏰ Self-followup queued for ${choomName}: ${entry.id} at ${entry.trigger_at} (${triggerLocal}) — "${prompt.slice(0, 80)}"${clampNote}`);
    return this.success(toolCall, {
      success: true,
      id: entry.id,
      trigger_at: entry.trigger_at,
      trigger_at_local: triggerLocal,
      delay_minutes: clamped,
      message: `Queued self-followup ${entry.id} for ${triggerLocal} (Donny's local time)${clampNote}. It will fire as a one-shot heartbeat. Sanity check: does that wall-clock time match the "morning/midday/evening" framing in your prompt?`,
    });
  }

  private async listFollowups(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    const pending = listEntries(ctx.choomId, 'pending');
    if (pending.length === 0) {
      return this.success(toolCall, { success: true, followups: [], message: 'No pending self-followups.' });
    }
    const userTz = 'America/Denver';
    return this.success(toolCall, {
      success: true,
      followups: pending.map(e => ({
        id: e.id,
        trigger_at: e.trigger_at,
        trigger_at_local: new Date(e.trigger_at).toLocaleString('en-US', {
          weekday: 'short', month: 'short', day: 'numeric',
          hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
          timeZone: userTz,
        }),
        prompt: e.prompt.slice(0, 200),
        reason: e.reason,
      })),
    });
  }

  private async cancelFollowup(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    const id = (toolCall.arguments.id as string || '').trim();
    if (!id) return this.error(toolCall, 'id is required. Use list_self_followups to see your pending ids.');

    const src = entryPath(ctx.choomId, 'pending', id);
    const dst = entryPath(ctx.choomId, 'cancelled', id);

    if (!fs.existsSync(src)) {
      return this.error(toolCall, `No pending self-followup with id "${id}". Call list_self_followups to see what's queued.`);
    }

    // Atomic claim: rename out of pending/ first so the scheduler can't fire it.
    try {
      fs.mkdirSync(bucketDir(ctx.choomId, 'cancelled'), { recursive: true });
      fs.renameSync(src, dst);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        return this.error(toolCall, `Self-followup "${id}" already fired or was cancelled.`);
      }
      throw err;
    }

    // Now update metadata in the cancelled bucket (only Node touches cancelled/, so this is safe).
    try {
      const raw = fs.readFileSync(dst, 'utf-8');
      const entry = JSON.parse(raw) as QueueEntry;
      entry.consumed = true;
      entry.status = 'cancelled';
      entry.cancelled_at = new Date().toISOString();
      atomicWriteJson(dst, entry);
    } catch {
      // Metadata update failed but the file is already in cancelled/ — that's still correct status.
    }

    console.log(`   🗑️  Self-followup cancelled: ${id}`);
    return this.success(toolCall, { success: true, id, message: `Cancelled ${id}.` });
  }
}

// Re-export root for any external consumer that previously imported it from here.
export { QUEUE_ROOT };
export type { Bucket };
