import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import type { ToolCall, ToolResult } from '@/lib/types';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import prisma from '@/lib/db';
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
  'schedule_room_followup',
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
      case 'schedule_room_followup':
        return this.scheduleRoomFollowup(toolCall, ctx);
      case 'list_self_followups':
        return this.listFollowups(toolCall, ctx);
      case 'cancel_self_followup':
        return this.cancelFollowup(toolCall, ctx);
      default:
        return this.error(toolCall, `Unknown self-scheduling tool: ${toolCall.name}`);
    }
  }

  // Resolve which group room a room-followup targets: the current room (if this
  // is a group turn), or a named room the Choom belongs to, or — if she's in
  // exactly one room — that one. Returns {id, title} or an {error} message.
  private async resolveRoom(ctx: SkillHandlerContext, roomArg: string | undefined):
    Promise<{ id: string; title: string } | { error: string }> {
    // Current room (group turn) wins when no explicit name is given.
    if (ctx.groupRoomId && !roomArg) {
      const r = await prisma.groupRoom.findUnique({ where: { id: ctx.groupRoomId } });
      if (r) return { id: r.id, title: r.title || 'this room' };
    }
    const mine = await prisma.groupRoom.findMany({
      where: { archived: false, participants: { some: { choomId: ctx.choomId, active: true } } },
      include: { participants: { include: { choom: true } } },
      orderBy: { updatedAt: 'desc' },
    });
    const label = (r: typeof mine[number]) => r.title
      || r.participants.filter(p => p.active).map(p => p.choom.name).join(' & ') || '(unnamed room)';
    if (mine.length === 0) {
      return { error: "You're not in any group rooms. Start one with talk_with_sisters first, then you can schedule a return." };
    }
    if (roomArg && roomArg.trim()) {
      const q = roomArg.toLowerCase().replace(/\bthe\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
      const hit = mine.find(r => {
        const t = label(r).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        return t && (t.includes(q) || q.includes(t));
      });
      if (hit) return { id: hit.id, title: label(hit) };
      return { error: `Couldn't find a room named "${roomArg}" that you're in. Your rooms: ${mine.map(label).join(', ')}.` };
    }
    if (ctx.groupRoomId) {
      const r = mine.find(m => m.id === ctx.groupRoomId);
      if (r) return { id: r.id, title: label(r) };
    }
    if (mine.length === 1) return { id: mine[0].id, title: label(mine[0]) };
    return { error: `You're in ${mine.length} rooms (${mine.map(label).join(', ')}). Pass the room name so I know which one to return to.` };
  }

  private async scheduleRoomFollowup(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    const rawDelay = toolCall.arguments.delay_minutes;
    const delay = typeof rawDelay === 'number' ? rawDelay : parseFloat(String(rawDelay));
    const prompt = (toolCall.arguments.prompt as string || '').trim();
    const reason = (toolCall.arguments.reason as string || '').trim();
    const roomArg = (toolCall.arguments.room as string || '').trim() || undefined;
    const choomName = ((ctx.choom as Record<string, unknown>)?.name as string) || 'unknown';

    if (!Number.isFinite(delay)) return this.error(toolCall, 'delay_minutes must be a number');
    if (!prompt) {
      return this.error(toolCall, 'prompt is required — what you want to say or do when you pop back into the room.');
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      return this.error(toolCall, `prompt is too long (${prompt.length} chars). Keep it under ${MAX_PROMPT_CHARS}.`);
    }

    const resolved = await this.resolveRoom(ctx, roomArg);
    if ('error' in resolved) return this.error(toolCall, resolved.error);

    const clamped = Math.max(MIN_DELAY_MIN, Math.min(MAX_DELAY_MIN, delay));
    const clampNote = clamped !== delay ? ` (clamped from ${delay} to ${clamped})` : '';

    const pendingCount = listEntries(ctx.choomId, 'pending').length;
    if (pendingCount >= MAX_PENDING_PER_CHOOM) {
      return this.error(toolCall, `You already have ${pendingCount} pending followups (max ${MAX_PENDING_PER_CHOOM}). Cancel one first with cancel_self_followup.`);
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
      target: 'room',
      room_id: resolved.id,
    };
    atomicWriteJson(entryPath(ctx.choomId, 'pending', entry.id), entry);

    const triggerLocal = triggerAt.toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: 'America/Denver',
    });
    console.log(`   ⏰ ROOM followup queued for ${choomName}: ${entry.id} → room "${resolved.title}" at ${entry.trigger_at} (${triggerLocal})${clampNote}`);
    return this.success(toolCall, {
      success: true,
      id: entry.id,
      room: resolved.title,
      trigger_at: entry.trigger_at,
      trigger_at_local: triggerLocal,
      delay_minutes: clamped,
      message: `Queued a room re-entry ${entry.id} for "${resolved.title}" at ${triggerLocal}${clampNote}. When it fires you'll re-enter that room (seeing the latest conversation) and your opening line will be your prompt — your sisters there can react.`,
    });
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

    // Wrong-tool guardrail: schedule_self_followup fires into your PRIVATE 1:1 /
    // Signal — NOT a room. If the prompt is clearly about returning to a group
    // room, the Choom meant schedule_room_followup. We AUTO-ROUTE rather than
    // just erroring with advice: erroring made models (esp. local ones) re-hammer
    // schedule_self_followup until the broken-tool cap disabled it — they never
    // switched tools. In a group turn the room is already known (ctx.groupRoomId),
    // so the redirect resolves trivially and just does the right thing. (These two
    // tools look alike and get mixed up.)
    const wantsRoom = /\b(?:pop|hop|jump|head|come|get|step)\s+(?:back\s+)?(?:in(?:to)?|to)\b[^.!?]{0,30}\b(?:room|lounge|group\s*chat)\b|\bback (?:in|into) (?:the )?(?:room|lounge|group\s*chat)\b|\bthis room\b|\bthe (?:tune )?lounge\b|\bgroup chat\b|\brejoin\b/i.test(prompt);
    if (wantsRoom) {
      console.log(`   🔀 ${choomName}: schedule_self_followup → schedule_room_followup (room-return intent auto-routed)`);
      const roomResult = await this.scheduleRoomFollowup(toolCall, ctx);
      // Annotate so the Choom learns the correct tool for next time, whether the
      // routed call succeeded or failed (e.g. she's not actually in a room).
      if (roomResult.result && typeof roomResult.result === 'object') {
        const r = roomResult.result as Record<string, unknown>;
        r.redirected_from = 'schedule_self_followup';
        r.note = 'Your prompt was about returning to a group room, so this was auto-routed to schedule_room_followup (a room re-entry, not a private 1:1 followup). Call schedule_room_followup directly next time.';
        if (typeof r.message === 'string') {
          r.message = `(Auto-routed from schedule_self_followup → schedule_room_followup because your prompt was about a group room.) ${r.message}`;
        }
      } else if (roomResult.error) {
        roomResult.error = `Tried to auto-route this to schedule_room_followup (your prompt was about a group room), but: ${roomResult.error} If you actually meant a PRIVATE 1:1 followup, reword the prompt without "room"/"lounge"/"group chat".`;
      }
      return roomResult;
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
        target: e.target === 'room' ? 'room' : 'signal',
        room_id: e.room_id,
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
