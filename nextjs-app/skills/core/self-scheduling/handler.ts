import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import type { ToolCall, ToolResult } from '@/lib/types';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import prisma from '@/lib/db';
import { parseLocalDateTime, timeFromPromptHeading } from '@/lib/local-time-parse';
import { parseRule, parseWeekday, nextOccurrence, describeRepeat, seriesKey, findCoveringEntry, oneShotsCoveredByRoutine, SLOT_WINDOW_MIN, type Repeat } from '@/lib/self-followup-recurrence';
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
  'edit_self_followup',
]);

const PREVIEW_CHARS = 90; // list_self_followups shows this much of each prompt unless asked for the whole

const MIN_DELAY_MIN = 15; // minimum lead time before a followup may fire
const MAX_DELAY_MIN = 30 * 24 * 60; // 30 days
const MAX_PROMPT_CHARS = 2000;
const MAX_PENDING_PER_CHOOM = 100;
const USER_TZ = 'America/Denver'; // Donny's local (Mountain) time

// Format a UTC instant as Donny's local wall clock for log lines + tool responses.
function fmtLocal(d: Date): string {
  return d.toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: USER_TZ,
  });
}

// The ids asked for: `id` as one id or several ("sf_a, sf_b"), or an `ids` array.
function idsFromArgs(a: Record<string, unknown>): string[] {
  const raw: unknown[] = Array.isArray(a.ids) ? a.ids : [a.id ?? a.followup_id ?? a.followupId ?? ''];
  return raw.flatMap(v => String(v ?? '').split(/[\s,]+/)).map(s => s.trim()).filter(s => /^sf_/i.test(s));
}

// "sf_x ↻ every day at 2:40 PM (next Thu, Nov 5, 2:40 PM) | signal" or "sf_x | Thu, Nov 5, 2:40 PM | room abc".
function followupHead(e: QueueEntry): string {
  const when = new Date(e.trigger_at).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZone: USER_TZ,
  });
  const where = e.target === 'room' ? `room${e.room_id ? ' ' + e.room_id : ''}` : 'signal';
  const rep = e.repeat ? ` ↻ ${describeRepeat(e.repeat)} (next ${when})` : ` | ${when}`;
  return `${e.id}${rep} | ${where}`;
}

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
      case 'edit_self_followup':
        return this.editFollowup(toolCall, ctx);
      default:
        return this.error(toolCall, `Unknown self-scheduling tool: ${toolCall.name}`);
    }
  }

  // Resolve the absolute trigger instant from EITHER `at` (a wall-clock time in
  // Donny's local zone — the easy path; no minutes-from-now math, no UTC) OR
  // `delay_minutes`. Enforces the [MIN_DELAY_MIN, MAX_DELAY_MIN] window. Returns
  // the trigger Date + a human note about any clamp, or an { error } string.
  private resolveTrigger(args: Record<string, unknown>):
    { triggerAt: Date; note: string; effectiveMinutes: number } | { error: string } {
    const now = Date.now();
    const minMs = now + MIN_DELAY_MIN * 60 * 1000;
    const maxMs = now + MAX_DELAY_MIN * 60 * 1000;
    // Alias rescue (C-42): models put the time under the wrong key — deepseek's
    // nightly heartbeats sent `time` instead of `at` five turns running
    // (08-01..08-03 traces), ate the param error each time, and the failure cap
    // then disabled the tool mid-heartbeat. A perfectly good value under an
    // obvious name is not an error: accept it and echo the real name back so
    // the model learns (same pattern as requireStringArg's path aliases, C-50).
    let aliasNote = '';
    let atRaw = (typeof args.at === 'string' ? args.at : '').trim();
    if (!atRaw) {
      for (const k of ['time', 'when', 'at_time', 'datetime']) {
        if (typeof args[k] === 'string' && (args[k] as string).trim()) {
          atRaw = (args[k] as string).trim();
          aliasNote = ` (heads-up: the parameter is named \`at\`, not \`${k}\` — accepted this time)`;
          break;
        }
      }
    }

    // Absolute time wins when provided — this is the path that spares a weak model
    // the minutes math and local-vs-UTC confusion.
    if (atRaw) {
      const parsed = parseLocalDateTime(atRaw, USER_TZ);
      if (!parsed) {
        return { error: `Couldn't read the time "${atRaw}". Give a wall-clock time in Donny's local (Mountain) time — e.g. "2026-06-26 2:05pm", "June 26 at 14:05", "tomorrow 9am", or just "2:05pm" for the next time it's that o'clock. (Or use delay_minutes instead.)` };
      }
      if (parsed.getTime() < now) {
        return { error: `That time (${fmtLocal(parsed)}) is already in the past — it's ${fmtLocal(new Date(now))} now. Pick a future time; if you meant today but it has passed, use tomorrow's date.` };
      }
      let t = parsed.getTime();
      let note = '';
      if (t < minMs) { t = minMs; note = ` (followups need a ${MIN_DELAY_MIN}-min minimum lead time, so bumped to ${fmtLocal(new Date(minMs))})`; }
      else if (t > maxMs) { t = maxMs; note = ' (capped to the 30-day maximum)'; }
      return { triggerAt: new Date(t), note: note + aliasNote, effectiveMinutes: Math.round((t - now) / 60000) };
    }

    // Fallback: minutes-from-now (with the same alias tolerance).
    let rawDelay = args.delay_minutes;
    if (rawDelay === undefined || rawDelay === null || String(rawDelay).trim() === '') {
      for (const k of ['minutes', 'delay', 'in_minutes', 'delayMinutes']) {
        const v = args[k];
        if (v !== undefined && v !== null && String(v).trim() !== '' && Number.isFinite(parseFloat(String(v)))) {
          rawDelay = v;
          aliasNote = ` (heads-up: the parameter is named \`delay_minutes\`, not \`${k}\` — accepted this time)`;
          break;
        }
      }
    }
    const hasDelay = rawDelay !== undefined && rawDelay !== null && String(rawDelay).trim() !== '';
    if (!hasDelay) {
      // No time argument, but the prompt's heading names one ("Thursday 6:30
      // AM, departure day: …") — use it and say so, rather than lose the
      // wake-up: most models never retried this error (35 of 45, 09-14..28).
      const fromHeading = timeFromPromptHeading(typeof args.prompt === 'string' ? args.prompt : '', USER_TZ);
      if (fromHeading && fromHeading.getTime() > now) {
        let t = fromHeading.getTime();
        let clamp = '';
        if (t < minMs) { t = minMs; clamp = `, bumped to ${fmtLocal(new Date(minMs))} for the ${MIN_DELAY_MIN}-min minimum lead time`; }
        else if (t > maxMs) { t = maxMs; clamp = ', capped to the 30-day maximum'; }
        return {
          triggerAt: new Date(t),
          note: ` (no \`at\` was given, so I read the time from your prompt's heading: ${fmtLocal(fromHeading)}${clamp}. Pass it as \`at\` next time; if that's not the time you meant, cancel this one and schedule again with \`at\`.)`,
          effectiveMinutes: Math.round((t - now) / 60000),
        };
      }
      // Name the keys that DID arrive — "you sent X" beats "you sent nothing"
      // when the model is staring at its own call wondering what was wrong.
      const KNOWN = new Set(['at', 'delay_minutes', 'prompt', 'reason', 'room']);
      const extras = Object.keys(args).filter(k => !KNOWN.has(k));
      const sentNote = extras.length ? ` (you sent ${extras.map(k => `\`${k}\``).join(', ')}, which I can't read a time from)` : '';
      return { error: `Provide either \`at\` (an absolute time like "2026-06-26 2:05pm" in Donny's local time) or \`delay_minutes\` (minutes from now)${sentNote}.` };
    }
    const delay = typeof rawDelay === 'number' ? rawDelay : parseFloat(String(rawDelay));
    if (!Number.isFinite(delay)) {
      return { error: 'delay_minutes must be a number — or use `at` to name the absolute time instead.' };
    }
    const clamped = Math.max(MIN_DELAY_MIN, Math.min(MAX_DELAY_MIN, delay));
    const note = clamped !== delay ? ` (clamped from ${delay} to ${clamped} min)` : '';
    return { triggerAt: new Date(now + clamped * 60 * 1000), note: note + aliasNote, effectiveMinutes: clamped };
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
      return { error: "You're not in any group rooms yet, so there's nothing to return to. Call list_my_rooms to see the rooms that exist and join_room to add yourself to one (you don't need an invite), or start a fresh one with talk_with_sisters — then you can schedule a return." };
    }
    if (roomArg && roomArg.trim()) {
      const q = roomArg.toLowerCase().replace(/\bthe\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
      const hit = mine.find(r => {
        const t = label(r).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        return t && (t.includes(q) || q.includes(t));
      });
      if (hit) return { id: hit.id, title: label(hit) };
      return { error: `Couldn't find a room named "${roomArg}" that you're in. Your rooms: ${mine.map(label).join(', ')}. If the room exists but you're not in it, join_room adds you — then schedule the return.` };
    }
    if (ctx.groupRoomId) {
      const r = mine.find(m => m.id === ctx.groupRoomId);
      if (r) return { id: r.id, title: label(r) };
    }
    if (mine.length === 1) return { id: mine[0].id, title: label(mine[0]) };
    return { error: `You're in ${mine.length} rooms (${mine.map(label).join(', ')}). Pass the room name so I know which one to return to.` };
  }

  private async scheduleRoomFollowup(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    const prompt = (toolCall.arguments.prompt as string || '').trim();
    const reason = (toolCall.arguments.reason as string || '').trim();
    const roomArg = (toolCall.arguments.room as string || '').trim() || undefined;
    const choomName = ((ctx.choom as Record<string, unknown>)?.name as string) || 'unknown';

    if (!prompt) {
      return this.error(toolCall, 'prompt is required — what you want to say or do when you pop back into the room.');
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      return this.error(toolCall, `prompt is too long (${prompt.length} chars). Keep it under ${MAX_PROMPT_CHARS}.`);
    }

    const resolved = await this.resolveRoom(ctx, roomArg);
    if ('error' in resolved) return this.error(toolCall, resolved.error);

    const trig = this.resolveTrigger(toolCall.arguments);
    if ('error' in trig) return this.error(toolCall, trig.error);
    let { triggerAt } = trig;
    const { note: clampNote } = trig;

    // Routine room re-entry? One entry, re-queued by the scheduler after every fire.
    const rep = this.resolveRepeat(toolCall.arguments, triggerAt);
    if (rep && 'error' in rep) return this.error(toolCall, rep.error);
    let roomRepeat: Repeat | undefined;
    if (rep) {
      roomRepeat = rep.repeat;
      triggerAt = rep.firstAt;
      const key = seriesKey(roomRepeat, 'room', resolved.id);
      const existing = listEntries(ctx.choomId, 'pending').find(e => e.repeat && seriesKey(e.repeat, e.target === 'room' ? 'room' : 'signal', e.room_id) === key);
      if (existing) {
        return this.success(toolCall, {
          success: true,
          already_scheduled: true,
          id: existing.id,
          room: resolved.title,
          routine: describeRepeat(roomRepeat),
          next_fire_local: fmtLocal(new Date(existing.trigger_at)),
          message: `You already return to "${resolved.title}" ${describeRepeat(roomRepeat)} (${existing.id}, next ${fmtLocal(new Date(existing.trigger_at))}). Nothing to add — it re-queues itself after every fire. To change what it says, use edit_self_followup with id ${existing.id}.`,
        });
      }
    }

    if (!roomRepeat) {
      const covering = findCoveringEntry(listEntries(ctx.choomId, 'pending'), triggerAt, 'room', resolved.id);
      if (covering) {
        return this.success(toolCall, {
          success: true,
          already_scheduled: true,
          id: covering.id,
          room: resolved.title,
          message: `Not added: ${covering.id} already returns you to "${resolved.title}" at ${fmtLocal(new Date(covering.trigger_at))}${covering.repeat ? ` (routine ${describeRepeat(covering.repeat)})` : ''}. To change what it says, use edit_self_followup with id ${covering.id}; cancel it first only if you want a different time.`,
        });
      }
    }

    const pendingCount = listEntries(ctx.choomId, 'pending').length;
    if (pendingCount >= MAX_PENDING_PER_CHOOM) {
      return this.error(toolCall, `You already have ${pendingCount} pending followups (max ${MAX_PENDING_PER_CHOOM}). Cancel one first with cancel_self_followup.`);
    }

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
      ...(roomRepeat ? { repeat: roomRepeat, series_id: `series_${randomUUID().slice(0, 8)}` } : {}),
    };
    atomicWriteJson(entryPath(ctx.choomId, 'pending', entry.id), entry);

    const triggerLocal = fmtLocal(triggerAt);
    console.log(`   ⏰ ROOM followup queued for ${choomName}: ${entry.id} → room "${resolved.title}" at ${entry.trigger_at} (${triggerLocal})${roomRepeat ? ` ↻ ${describeRepeat(roomRepeat)}` : ''}${clampNote}`);
    return this.success(toolCall, {
      success: true,
      id: entry.id,
      ...(roomRepeat ? { routine: describeRepeat(roomRepeat), note: 'This is a routine: it re-queues itself after every fire.' } : {}),
      room: resolved.title,
      trigger_at: entry.trigger_at,
      trigger_at_local: triggerLocal,
      delay_minutes: trig.effectiveMinutes,
      message: `Queued a room re-entry ${entry.id} for "${resolved.title}" at ${triggerLocal}${clampNote}. When it fires you'll re-enter that room (seeing the latest conversation) and your opening line will be your prompt — your sisters there can react.`,
    });
  }

  /**
   * A routine: the rule from `repeat`/`day`, the clock time from the resolved
   * `at`. Returns null when no repeat was asked for, an error string when the
   * ask is malformed, else the Repeat plus its FIRST occurrence (strictly in
   * the future, at least MIN_DELAY_MIN out).
   */
  private resolveRepeat(args: Record<string, unknown>, triggerAt: Date): { repeat: Repeat; firstAt: Date } | { error: string } | null {
    // Models improvise parameter names (DeepSeek's first try, 2026-09-12:
    // {routine:"weekly", time:"18:00", day_of_week:"friday"}); accept the
    // obvious aliases rather than making her cancel and redo.
    const rawRepeat = args.repeat ?? args.routine ?? args.recurrence ?? args.recurring ?? args.every ?? args.frequency ?? args.interval;
    const rawDay = args.day ?? args.day_of_week ?? args.weekday ?? args.day_of_month ?? args.dayOfWeek ?? args.dayOfMonth;
    if (rawRepeat === undefined || rawRepeat === null || rawRepeat === '' || rawRepeat === false) return null;
    let rule = parseRule(rawRepeat);
    let dayFromRule: string | undefined;
    if (!rule && typeof rawRepeat === 'string') {
      // "every friday" / "fridays" / "friday" → weekly on that day
      const m = rawRepeat.toLowerCase().match(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/);
      if (m) { rule = 'weekly'; dayFromRule = m[1]; }
    }
    if (!rule) return { error: `repeat must be one of daily, weekdays, weekly, monthly (got "${String(rawRepeat)}").` };
    const args2 = { ...args, day: rawDay ?? dayFromRule };
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: USER_TZ, hour12: false, hour: '2-digit', minute: '2-digit', weekday: 'short', day: 'numeric' })
      .formatToParts(triggerAt).reduce<Record<string, string>>((acc, p) => { acc[p.type] = p.value; return acc; }, {});
    const time = `${String(Number(parts.hour) % 24).padStart(2, '0')}:${parts.minute}`;
    const repeat: Repeat = { rule, time, tz: USER_TZ };
    if (rule === 'weekly') {
      const day = parseWeekday(args2.day) ?? parseWeekday(parts.weekday);
      if (!day) return { error: 'repeat="weekly" needs a weekday in `day` (e.g. "fri").' };
      repeat.day = day;
    } else if (rule === 'monthly') {
      const dom = Number(args2.day ?? parts.day);
      if (!Number.isFinite(dom) || dom < 1 || dom > 28) return { error: 'repeat="monthly" needs `day` as a day of month 1-28.' };
      repeat.day_of_month = dom;
    }
    const minStart = new Date(Date.now() + MIN_DELAY_MIN * 60 * 1000 - 60_000);
    // If the requested first fire is itself a valid future occurrence, keep it;
    // otherwise roll forward to the next one.
    const firstAt = triggerAt.getTime() >= minStart.getTime() && nextOccurrence(repeat, new Date(triggerAt.getTime() - 60_000)).getTime() === triggerAt.getTime()
      ? triggerAt
      : nextOccurrence(repeat, minStart);
    return { repeat, firstAt };
  }

  private async scheduleFollowup(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    const prompt = (toolCall.arguments.prompt as string || '').trim();
    const reason = (toolCall.arguments.reason as string || '').trim();
    const choomName = ((ctx.choom as Record<string, unknown>)?.name as string) || 'unknown';

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

    const resolved = this.resolveTrigger(toolCall.arguments);
    if ('error' in resolved) return this.error(toolCall, resolved.error);
    let { triggerAt } = resolved;
    const { note: clampNote } = resolved;

    // Routine? One entry, re-queued by the scheduler after every fire.
    const rep = this.resolveRepeat(toolCall.arguments, triggerAt);
    if (rep && 'error' in rep) return this.error(toolCall, rep.error);
    let repeat: Repeat | undefined;
    if (rep) {
      repeat = rep.repeat;
      triggerAt = rep.firstAt;
      const key = seriesKey(repeat, 'signal');
      const existing = listEntries(ctx.choomId, 'pending').find(e => e.repeat && seriesKey(e.repeat, e.target === 'room' ? 'room' : 'signal', e.room_id) === key);
      if (existing) {
        return this.success(toolCall, {
          success: true,
          already_scheduled: true,
          id: existing.id,
          routine: describeRepeat(repeat),
          next_fire_local: fmtLocal(new Date(existing.trigger_at)),
          message: `You already have a routine ${describeRepeat(repeat)} (${existing.id}, next ${fmtLocal(new Date(existing.trigger_at))}). Nothing to add — it re-queues itself after every fire. To change what it says, use edit_self_followup with id ${existing.id} (same time, same routine, new words).`,
        });
      }
    }

    // Slot guard (2026-09-12): a one-shot within 20 minutes of an existing
    // wake-up — or of a routine that fires that day — is the same wake-up.
    if (!repeat) {
      const covering = findCoveringEntry(listEntries(ctx.choomId, 'pending'), triggerAt, 'signal');
      if (covering) {
        const when = fmtLocal(new Date(covering.trigger_at));
        return this.success(toolCall, {
          success: true,
          already_scheduled: true,
          id: covering.id,
          covered_by: covering.repeat ? `routine ${describeRepeat(covering.repeat)}` : `one-shot at ${when}`,
          message: covering.repeat
            ? `Not added: your routine "${describeRepeat(covering.repeat)}" (${covering.id}) already wakes you then. If this wake-up needs something specific, put it in a memory or add it to the routine's prompt with edit_self_followup.`
            : `Not added: ${covering.id} already wakes you at ${when} (within ${SLOT_WINDOW_MIN} min): "${covering.prompt.slice(0, 80)}". To change what it says, use edit_self_followup with id ${covering.id}; cancel it first only if you want a different time.`,
        });
      }
    }

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
      ...(repeat ? { repeat, series_id: `series_${randomUUID().slice(0, 8)}` } : {}),
    };

    // A new routine makes the hand-scheduled copies of the same ritual
    // redundant; name them so she can clear them in one cancel each.
    const covered = repeat ? oneShotsCoveredByRoutine(listEntries(ctx.choomId, 'pending'), repeat, 'signal') : [];

    atomicWriteJson(entryPath(ctx.choomId, 'pending', entry.id), entry);

    const triggerLocal = fmtLocal(triggerAt);

    console.log(`   ⏰ Self-followup queued for ${choomName}: ${entry.id} at ${entry.trigger_at} (${triggerLocal})${repeat ? ` ↻ ${describeRepeat(repeat)}` : ''} — "${prompt.slice(0, 80)}"${clampNote}${covered.length ? ` (covers ${covered.length} one-shots)` : ''}`);
    return this.success(toolCall, {
      success: true,
      id: entry.id,
      ...(repeat ? { routine: describeRepeat(repeat), note: 'This is a routine: it re-queues itself after every fire. Do not schedule the next occurrence by hand.' } : {}),
      ...(covered.length ? {
        now_redundant: covered.map(e => e.id),
        note_redundant: `This routine now covers ${covered.length} of your pending one-shots (${covered.map(e => `${e.id} ${fmtLocal(new Date(e.trigger_at))}`).join('; ')}). Cancel them with cancel_self_followup so you do not wake twice — unless one carries something specific for that day.`,
      } : {}),
      trigger_at: entry.trigger_at,
      trigger_at_local: triggerLocal,
      delay_minutes: resolved.effectiveMinutes,
      message: repeat
        ? `Queued routine ${entry.id}: ${describeRepeat(repeat)}, first fire ${triggerLocal} (Donny's local time). It re-queues itself; never schedule its next occurrence by hand.`
        : `Queued self-followup ${entry.id} for ${triggerLocal} (Donny's local time)${clampNote}. It will fire as a one-shot heartbeat. Sanity check: does that wall-clock time match the "morning/midday/evening" framing in your prompt?`,
    });
  }

  private async listFollowups(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    const pending = listEntries(ctx.choomId, 'pending');
    if (pending.length === 0) {
      return this.success(toolCall, { success: true, followups: [], message: 'No pending self-followups.' });
    }
    // Whole notes on request (2026-11-05): the list cut every prompt at 90 characters and nothing
    // showed the rest. Genesis, tidying her 14 hourly check-ins, could judge none of them, and her
    // 2:40 and 3:40 notes looked identical when cut. `id` (one or several) or `full` shows them whole.
    const a = toolCall.arguments || {};
    const wanted = idsFromArgs(a);
    const full = a.full === true || /^(true|yes|1)$/i.test(String(a.full ?? ''));
    // Compact (Phase 1, 2026-09-12): one line per pending entry, soonest first.
    // The object-per-entry form cost ~400 chars each — 31 pending entries was a
    // 12k-char result on every grounding turn. A line carries what she needs to
    // decide (when, where, what) plus the id for cancel_self_followup.
    // Routines (2026-09-12) come first, marked ↻ with their rule, so she sees
    // at a glance which wake-ups already repeat and never re-adds them.
    const sorted = [...pending].sort((a, b) => (b.repeat ? 1 : 0) - (a.repeat ? 1 : 0) || a.trigger_at.localeCompare(b.trigger_at));
    const shown = wanted.length ? sorted.filter(e => wanted.includes(e.id)) : sorted;
    let cut = 0;
    const lines = shown.map(e => {
      const what = e.prompt.replace(/\s+/g, ' ').trim();
      const whole = full || wanted.length > 0 || what.length <= PREVIEW_CHARS;
      if (!whole) cut++;
      return `${followupHead(e)} | ${whole ? what : what.slice(0, PREVIEW_CHARS - 1) + '…'}`;
    });
    const routineCount = pending.filter(e => e.repeat).length;
    const result: Record<string, unknown> = {
      success: true,
      pending_count: pending.length,
      routine_count: routineCount,
      format: 'id | when (Mountain time) | where | prompt — entries marked ↻ are routines that re-queue themselves; do not schedule their next occurrence by hand',
      followups: lines,
    };
    if (cut) {
      result.cut_short = `${cut} of these prompts are longer than ${PREVIEW_CHARS} characters and end in "…" here. To read one whole, call list_self_followups with its id (several: id="sf_a, sf_b"); full=true shows every one whole.`;
    }
    if (wanted.length) {
      const missing = wanted.filter(id => !shown.some(e => e.id === id));
      if (missing.length) {
        result.not_pending = missing.map(id => {
          const bucket = (['fired', 'cancelled', 'error'] as Bucket[]).find(b => fs.existsSync(entryPath(ctx.choomId, b, id)));
          return `${id}: ${bucket === 'fired' ? 'already fired' : bucket ? bucket : 'no such followup — copy ids from the list, never type one from memory'}`;
        });
      }
    }
    return this.success(toolCall, result);
  }

  // Reword a pending followup in place (2026-11-05): same id, same time, and a routine keeps its
  // series, so every later copy carries the new words. Changing a note used to mean cancel and
  // schedule again; Genesis did that for her 8:40 and 10:40 check-ins, and in the same batch
  // cancelled her 2:40 and 3:40 ones by mistake.
  private async editFollowup(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    const a = toolCall.arguments || {};
    const id = String(a.id ?? a.followup_id ?? a.followupId ?? '').trim();
    const prompt = String(a.prompt ?? a.new_prompt ?? a.text ?? '').trim();
    const reason = typeof a.reason === 'string' ? a.reason.trim() : undefined;
    const choomName = ((ctx.choom as Record<string, unknown>)?.name as string) || 'unknown';

    if (!id) return this.error(toolCall, 'id is required — copy it from list_self_followups (it looks like "sf_1a2b3c4d").');
    if (!prompt) {
      return this.error(toolCall, `prompt is required: the whole new wording. It replaces the old prompt entirely, so include everything you want to keep (list_self_followups with id="${id}" shows the current one in full).`);
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      return this.error(toolCall, `prompt is too long (${prompt.length} chars). Keep it under ${MAX_PROMPT_CHARS}.`);
    }

    const src = entryPath(ctx.choomId, 'pending', id);
    const gone = () => {
      const bucket = (['fired', 'cancelled', 'error'] as Bucket[]).find(b => fs.existsSync(entryPath(ctx.choomId, b, id)));
      if (bucket === 'fired') return `${id} already fired, so there is nothing to reword. If it is a routine, its next copy has a new id: call list_self_followups and edit that one.`;
      if (bucket) return `${id} is ${bucket}, not pending, so there is nothing to reword.`;
      return `No pending followup has the id ${id}. Call list_self_followups and copy the id from it; never type one from memory.`;
    };
    if (!fs.existsSync(src)) return this.error(toolCall, gone());

    // Claim it first, the way the scheduler does: a rename out of pending/ means it can't fire
    // half-edited, and if it fired a moment ago the rename fails and nothing comes back to life.
    const claim = `${src}.editing.${process.pid}.${Date.now()}`;
    try {
      fs.renameSync(src, claim);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return this.error(toolCall, gone());
      throw err;
    }
    let entry: QueueEntry;
    try {
      entry = JSON.parse(fs.readFileSync(claim, 'utf-8')) as QueueEntry;
    } catch (err) {
      fs.renameSync(claim, src);
      return this.error(toolCall, `Couldn't read ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }

    const before = entry.prompt;
    if (before === prompt && (reason === undefined || reason === entry.reason)) {
      fs.renameSync(claim, src);
      return this.success(toolCall, { success: true, id, unchanged: true, message: `${id} already says exactly that. Nothing changed.` });
    }

    const now = new Date().toISOString();
    const edited: QueueEntry = {
      ...entry,
      prompt,
      ...(reason !== undefined ? { reason } : {}),
      // The wake line says how old the note is so she can weigh what it assumes; these words are new.
      written_at: now,
      edited_at: now,
      previous_prompt: before,
    };
    try {
      atomicWriteJson(src, edited);
    } catch (err) {
      fs.renameSync(claim, src);
      return this.error(toolCall, `Couldn't save the new wording for ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    try { fs.unlinkSync(claim); } catch { /* a leftover .editing file is ignored by the scheduler */ }

    const when = fmtLocal(new Date(entry.trigger_at));
    const routine = entry.repeat ? describeRepeat(entry.repeat) : undefined;
    console.log(`   ✏️  Self-followup reworded for ${choomName}: ${id}${routine ? ` ↻ ${routine}` : ` at ${when}`} — "${before.replace(/\s+/g, ' ').slice(0, 60)}" → "${prompt.replace(/\s+/g, ' ').slice(0, 60)}"`);
    return this.success(toolCall, {
      success: true,
      id,
      edited: true,
      ...(routine ? { routine } : {}),
      next_fire_local: when,
      prompt,
      message: routine
        ? `Reworded ${id} (${routine}, next ${when}). Same id and time; every later copy of this routine uses the new words.`
        : `Reworded ${id} (fires ${when}). Same id and time.`,
    });
  }

  // Cancel ONE pending followup by id. Returns true if it was cancelled, false if
  // it wasn't pending (already fired/cancelled, or never existed). Never throws for
  // the not-found case — idempotent so it can be reused by the bulk path.
  private cancelOne(choomId: string, id: string): boolean {
    const src = entryPath(choomId, 'pending', id);
    const dst = entryPath(choomId, 'cancelled', id);
    if (!fs.existsSync(src)) return false;
    // Atomic claim: rename out of pending/ first so the scheduler can't fire it.
    try {
      fs.mkdirSync(bucketDir(choomId, 'cancelled'), { recursive: true });
      fs.renameSync(src, dst);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return false; // raced with a fire/cancel
      throw err;
    }
    // Update metadata in the cancelled bucket (only Node touches cancelled/).
    try {
      const entry = JSON.parse(fs.readFileSync(dst, 'utf-8')) as QueueEntry;
      entry.consumed = true;
      entry.status = 'cancelled';
      entry.cancelled_at = new Date().toISOString();
      atomicWriteJson(dst, entry);
    } catch {
      // File is already in cancelled/ — the status is correct enough.
    }
    return true;
  }

  private async cancelFollowup(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    // `followup_id` / `followupId` / `ids`: names models improvise (DeepSeek, 2026-09-12).
    const a = toolCall.arguments;
    const id = String(a.id ?? a.followup_id ?? a.followupId ?? a.followup ?? (Array.isArray(a.ids) && a.ids.length === 1 ? a.ids[0] : '') ?? '').trim();
    if (!id) return this.error(toolCall, 'id is required — use list_self_followups to see your pending ids, or id="all" to cancel them all.');

    // Bulk cancel: clear every pending followup in ONE call. Eve had ~15 to clear
    // and cancelling them one-by-one (after guessing ids) tripped the per-tool
    // failure cap and disabled the tool mid-cleanup.
    if (/^(all|\*|everything|clear)$/i.test(id)) {
      const pending = listEntries(ctx.choomId, 'pending');
      const cancelled: string[] = [];
      for (const e of pending) if (this.cancelOne(ctx.choomId, e.id)) cancelled.push(e.id);
      console.log(`   🗑️  Self-followups bulk-cancelled for ${ctx.choomId}: ${cancelled.length}`);
      return this.success(toolCall, {
        success: true,
        cancelled_count: cancelled.length,
        cancelled_ids: cancelled,
        message: cancelled.length
          ? `Cancelled all ${cancelled.length} pending followup${cancelled.length === 1 ? '' : 's'}.`
          : 'You had no pending followups — nothing to cancel.',
      });
    }

    // Name what was cancelled, so a wrong id shows at once (Nov 5: Genesis cancelled her 2:40
    // and 3:40 check-ins meaning others, and only found out by probing every hour).
    const target = listEntries(ctx.choomId, 'pending').find(e => e.id === id);
    if (this.cancelOne(ctx.choomId, id)) {
      const remaining = listEntries(ctx.choomId, 'pending').length;
      const was = target ? followupHead(target).slice(id.length).replace(/^ \| /, ' ').trim() : '';
      const what = target ? target.prompt.replace(/\s+/g, ' ').trim() : '';
      console.log(`   🗑️  Self-followup cancelled: ${id}${was ? ` (${was})` : ''}`);
      return this.success(toolCall, {
        success: true, cancelled: true, id, remaining,
        ...(target ? { was, prompt: what } : {}),
        message: `Cancelled ${id}${was ? ` (${was})` : ''}.${remaining ? ` ${remaining} still pending.` : ''}${target ? ' If that is not the one you meant, schedule it again now with the prompt above, which is what it said.' : ''}`,
      });
    }

    // Not found → idempotent SUCCESS (the desired end-state — that id is not
    // pending — already holds). Returning an ERROR here used to count as a hard
    // failure; two guessed ids ("1","2") tripped the per-tool cap and DISABLED the
    // tool, blocking the real cancels that came after. Hand back the actual pending
    // list so the model retries with a correct id (or uses id="all").
    const pending = listEntries(ctx.choomId, 'pending');
    return this.success(toolCall, {
      success: true,
      cancelled: false,
      already_absent: true,
      id,
      pending: pending.map(e => ({ id: e.id, trigger_at: e.trigger_at, prompt: e.prompt.slice(0, 80) })),
      message: pending.length
        ? `No pending followup with id "${id}" (already fired/cancelled, or the id was wrong — nothing to cancel). Your ${pending.length} actual pending id${pending.length === 1 ? ' is' : 's are'}: ${pending.map(e => e.id).join(', ')}. To clear them all at once, call cancel_self_followup with id="all".`
        : `No pending followup with id "${id}", and you have no pending followups at all — nothing to cancel.`,
    });
  }
}

// Re-export root for any external consumer that previously imported it from here.
export { QUEUE_ROOT };
export type { Bucket };
