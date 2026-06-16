import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import type { ToolCall, ToolResult } from '@/lib/types';
import prisma from '@/lib/db';
import { Agent, fetch as undiciFetch } from 'undici';
import { getOwnerIdentity } from '@/lib/owner';

const TOOL_NAMES = new Set([
  'talk_with_sisters', 'list_my_rooms', 'leave_room', 'rename_room', 'set_room_topic',
]);
const MAX_ROUNDS = 10;
const dispatcher = new Agent({ bodyTimeout: 0, headersTimeout: 0 });

// Loose title normalization for matching a spoken room name ("the Tune Lounge")
// against a stored title — drop "the", collapse punctuation to spaces.
function normTitle(s: string): string {
  return (s || '').toLowerCase().replace(/\bthe\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

type RoomWithParticipants = Awaited<ReturnType<typeof prisma.groupRoom.findMany>>[number] & {
  participants: Array<{ id: string; choomId: string; order: number; active: boolean; choom?: { name: string } }>;
};

export default class GroupChatHandler extends BaseSkillHandler {
  canHandle(toolName: string): boolean {
    return TOOL_NAMES.has(toolName);
  }

  // Find the (active, non-archived) room the caller means: by loose name match,
  // or — when no name is given — their single room if they're only in one.
  private async findMyRoom(callerId: string, roomQuery?: string): Promise<{ room: RoomWithParticipants | null; candidates: RoomWithParticipants[] }> {
    const mine = (await prisma.groupRoom.findMany({
      where: { archived: false, participants: { some: { choomId: callerId, active: true } } },
      include: { participants: { include: { choom: true } } },
      orderBy: { updatedAt: 'desc' },
    })) as unknown as RoomWithParticipants[];
    if (mine.length === 0) return { room: null, candidates: [] };
    if (roomQuery && roomQuery.trim()) {
      const q = normTitle(roomQuery);
      const hit = mine.find(r => { const t = normTitle(r.title || ''); return t && (t.includes(q) || q.includes(t)); });
      return { room: hit || null, candidates: mine };
    }
    // No name given: use it only if it's unambiguous.
    return { room: mine.length === 1 ? mine[0] : null, candidates: mine };
  }

  private roomLabel(r: RoomWithParticipants): string {
    return r.title || r.participants.filter(p => p.active).map(p => p.choom?.name).filter(Boolean).join(' & ') || '(unnamed room)';
  }

  async execute(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    const args = (toolCall.arguments || {}) as Record<string, unknown>;

    // Resolve the caller (initiator).
    const callerId = ctx.choomId;
    const caller = await prisma.choom.findUnique({ where: { id: callerId } });
    if (!caller) return this.error(toolCall, 'Could not resolve your own Choom record.');

    if (toolCall.name === 'list_my_rooms') {
      const rooms = await prisma.groupRoom.findMany({
        where: { archived: false, participants: { some: { choomId: caller.id, active: true } } },
        include: { participants: { include: { choom: true } }, _count: { select: { messages: true } } },
        orderBy: { updatedAt: 'desc' },
      });
      return this.success(toolCall, {
        rooms: rooms.map(r => ({
          name: r.title || r.participants.map(p => p.choom.name).join(' & '),
          members: r.participants.filter(p => p.active).map(p => p.choom.name),
          messages: r._count.messages,
          last_active: r.updatedAt,
        })),
        note: rooms.length
          ? `You're in ${rooms.length} room(s). To return to one, call talk_with_sisters with room set to its name.`
          : "You're not in any group rooms yet. Start one with talk_with_sisters.",
      });
    }

    // ── leave_room: a Choom removes HERSELF (never others). History is kept. ──
    if (toolCall.name === 'leave_room') {
      const { room, candidates } = await this.findMyRoom(caller.id, typeof args.room === 'string' ? args.room : undefined);
      if (!room) {
        if (candidates.length === 0) return this.error(toolCall, "You're not in any group rooms, so there's nothing to leave.");
        return this.error(toolCall, `Which room do you want to leave? You're in: ${candidates.map(r => `"${this.roomLabel(r)}"`).join(', ')}. Pass the name as the "room" parameter.`);
      }
      await prisma.groupParticipant.updateMany({ where: { roomId: room.id, choomId: caller.id }, data: { active: false } });
      const label = this.roomLabel(room);
      return this.success(toolCall, {
        left: label,
        note: `You've left "${label}". Your past messages stay in the room's history. You can't rejoin yourself — a sibling can invite you back by naming you in talk_with_sisters with room "${label}", or ${getOwnerIdentity().name} can re-add you.`,
      });
    }

    // ── rename_room: rename a room the caller is in. Lookups key off title, so a ──
    //    rename is all that's needed for tools + siblings to find it by the new name.
    if (toolCall.name === 'rename_room') {
      const newName = (typeof args.new_name === 'string' && args.new_name.trim())
        || (typeof args.name === 'string' && args.name.trim()) || '';
      if (!newName) return this.error(toolCall, 'The "new_name" parameter is required: the new name to give the room.');
      const { room, candidates } = await this.findMyRoom(caller.id, typeof args.room === 'string' ? args.room : undefined);
      if (!room) {
        if (candidates.length === 0) return this.error(toolCall, "You're not in any rooms to rename.");
        return this.error(toolCall, `Which room? You're in: ${candidates.map(r => `"${this.roomLabel(r)}"`).join(', ')}. Pass the current name as "room" and the new name as "new_name".`);
      }
      const oldLabel = this.roomLabel(room);
      await prisma.groupRoom.update({ where: { id: room.id }, data: { title: newName } });
      return this.success(toolCall, {
        renamed: { from: oldLabel, to: newName },
        note: `Renamed "${oldLabel}" to "${newName}". You and your siblings can now reach it with room: "${newName}" — the conversation history is unchanged.`,
      });
    }

    // ── set_room_topic: pin a one-line purpose that's injected into every turn. ──
    //    Stored via raw SQL on the GroupRoom.topic column so it works without a
    //    Prisma client regeneration (graceful with the running dev server).
    if (toolCall.name === 'set_room_topic') {
      const topic = typeof args.topic === 'string' ? args.topic.trim() : '';
      const { room, candidates } = await this.findMyRoom(caller.id, typeof args.room === 'string' ? args.room : undefined);
      if (!room) {
        if (candidates.length === 0) return this.error(toolCall, "You're not in any rooms.");
        return this.error(toolCall, `Which room? You're in: ${candidates.map(r => `"${this.roomLabel(r)}"`).join(', ')}. Pass the name as "room".`);
      }
      await prisma.$executeRaw`UPDATE GroupRoom SET topic = ${topic || null} WHERE id = ${room.id}`;
      const label = this.roomLabel(room);
      return this.success(toolCall, {
        room: label,
        topic,
        note: topic
          ? `Pinned the topic for "${label}": "${topic}". Everyone in the room will see it as guiding context on every turn.`
          : `Cleared the topic for "${label}".`,
      });
    }

    // ── talk_with_sisters ──────────────────────────────────────────────────────

    // Normalize sisters (array or comma string), drop the caller if listed.
    let sisterNames: string[] = [];
    if (Array.isArray(args.sisters)) sisterNames = args.sisters.map(s => String(s));
    else if (typeof args.sisters === 'string') sisterNames = args.sisters.split(',').map(s => s.trim());
    sisterNames = sisterNames.filter(n => n && n.toLowerCase() !== caller.name.toLowerCase());
    if (sisterNames.length === 0) {
      // Phrase as "is required" so the loop classifies this as a recoverable
      // param error (not a tool failure that disables the tool after 2 tries),
      // and tell the model EXACTLY what to add — local models routinely put the
      // sister's name in the prose but omit the structured `sisters` array.
      return this.error(toolCall, 'The "sisters" parameter is required: pass an array of sister names, e.g. sisters: ["Eve"]. Naming someone in the message text is not enough — add them to the sisters array (list only OTHERS, not yourself).');
    }

    const message = typeof args.message === 'string' ? args.message.trim() : '';
    if (!message) return this.error(toolCall, 'The "message" parameter is required: provide your opening line for the conversation, in your own voice.');

    const rounds = Math.max(1, Math.min(MAX_ROUNDS, typeof args.rounds === 'number' ? args.rounds : 3));

    // Resolve sister Chooms by name (case-insensitive).
    const allChooms = await prisma.choom.findMany();
    const byName = new Map(allChooms.map(c => [c.name.toLowerCase(), c]));
    const sisters = [];
    const notFound = [];
    for (const n of sisterNames) {
      const c = byName.get(n.toLowerCase());
      if (c) sisters.push(c); else notFound.push(n);
    }
    if (sisters.length === 0) {
      return this.error(toolCall, `Couldn't find ${notFound.join(', ')}. Use exact Choom names.`);
    }

    // Build the participant set (caller first, then sisters).
    const participantIds = [caller.id, ...sisters.map(s => s.id)];
    const wantKey = [...participantIds].sort().join(',');
    const existingRooms = (await prisma.groupRoom.findMany({
      where: { archived: false },
      include: { participants: true },
    })) as unknown as RoomWithParticipants[];

    let room: RoomWithParticipants | null = null;
    let addedNames: string[] = [];
    const roomQuery = typeof args.room === 'string' ? args.room.trim().toLowerCase() : '';
    if (roomQuery) {
      // Return to a NAMED room the caller is in (e.g. "the lounge"). Match the
      // title loosely (ignore filler words like "the").
      const q = normTitle(roomQuery);
      const mine = existingRooms.filter(r => r.participants.some(p => p.active && p.choomId === caller.id));
      room = mine.find(r => {
        const t = normTitle(r.title || '');
        return t && (t.includes(q) || q.includes(t));
      }) || null;
      if (!room) {
        const names = mine.map(r => r.title).filter(Boolean).join(', ') || '(none)';
        return this.error(toolCall, `Couldn't find a room named "${args.room}" that you're in. Your rooms: ${names}. Call list_my_rooms to see them.`);
      }
      // ADD: bring any named sisters who aren't already active members INTO this
      // existing room (so "talk with Eve and Aloy in the Tune Lounge" pulls Aloy
      // in — she joins and sees the full backlog — instead of forking a new room).
      const activeIds = new Set(room.participants.filter(p => p.active).map(p => p.choomId));
      const toAdd = sisters.filter(s => !activeIds.has(s.id));
      if (toAdd.length) {
        const maxOrder = room.participants.reduce((m, p) => Math.max(m, p.order), 0);
        for (let i = 0; i < toAdd.length; i++) {
          const s = toAdd[i];
          const existing = room.participants.find(p => p.choomId === s.id);
          if (existing) {
            await prisma.groupParticipant.update({ where: { id: existing.id }, data: { active: true } });
          } else {
            await prisma.groupParticipant.create({ data: { roomId: room.id, choomId: s.id, order: maxOrder + 1 + i, active: true } });
          }
        }
        addedNames = toAdd.map(s => s.name);
      }
    }

    // No named room → reuse the room with EXACTLY this participant set, or create one.
    if (!room) {
      room = existingRooms.find(r => {
        const ids = r.participants.filter(p => p.active).map(p => p.choomId).sort().join(',');
        return ids === wantKey;
      }) || null;
    }

    if (!room) {
      const title = `Sisters: ${[caller.name, ...sisters.map(s => s.name)].join(' & ')}`;
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
      const created = await prisma.groupRoom.create({
        data: {
          title,
          autoRounds: MAX_ROUNDS,
          participants: { create: participantIds.map((id, i) => ({ choomId: id, order: i, active: true })) },
        },
      });
      // Unique room folder (suffixed with room id) under choom_commons/.
      const projectFolder = `choom_commons/rooms/${slug}-${created.id.slice(-6)}`;
      try {
        const fs = await import('fs');
        const path = await import('path');
        const { WORKSPACE_ROOT } = await import('@/lib/config');
        fs.mkdirSync(path.join(WORKSPACE_ROOT, projectFolder), { recursive: true });
      } catch { /* folder is auto-created on first write anyway */ }
      room = (await prisma.groupRoom.update({ where: { id: created.id }, data: { projectFolder }, include: { participants: true } })) as unknown as RoomWithParticipants;
      // Provenance: record who created the room and in what context, in the
      // room's ActivityLog (visible via the room's Activity Log button).
      await prisma.activityLog.create({
        data: {
          choomId: caller.id, chatId: room.id, level: 'info', category: 'system',
          title: 'Room created',
          message: `Created by ${caller.name} ${ctx.isHeartbeat ? 'during a heartbeat' : 'from a 1:1 chat'}.`,
        },
      }).catch(() => { /* logging is best-effort */ });
    }

    // Run the conversation by calling the orchestrator with us as the initiator.
    const baseUrl = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
    ctx.send({ type: 'status', content: `Starting a group chat with ${sisters.map(s => s.name).join(', ')}…` });

    let transcript = '';
    let speakers = 0;
    try {
      const response = await undiciFetch(`${baseUrl}/api/group-chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: room.id,
          message,
          initiatorChoomId: caller.id,
          rounds,
          settings: ctx.settings,
          triggerSource: ctx.isHeartbeat ? 'heartbeat' : 'chat',
        }),
        dispatcher,
      });
      // 409 = the room is already running (or just ran moments ago). This is the
      // duplicate-trigger guard, not a failure — return a calm note so the loop
      // (e.g. a heartbeat that echoed a task you already did) simply stops here
      // instead of treating it as a broken tool and retrying.
      if (response.status === 409) {
        let reason = 'That room is already active right now.';
        try { const j = await response.json() as { error?: string }; if (j?.error) reason = j.error; } catch { /* keep default */ }
        return this.success(toolCall, {
          skipped: true,
          room_id: room.id,
          room_title: room.title,
          note: `${reason} I didn't start a duplicate conversation. Nothing more to do here — your sisters are already talking (or just finished).`,
        });
      }
      if (!response.ok) {
        const t = await response.text().catch(() => '');
        return this.error(toolCall, `Group chat failed (${response.status}): ${t.slice(0, 200)}`);
      }
      const reader = response.body?.getReader();
      if (!reader) return this.error(toolCall, 'No response stream from the group chat.');
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'speaker_done' && data.content) {
              speakers++;
              transcript += `${data.speakerName}: ${data.content}\n\n`;
              ctx.send({ type: 'status', content: `${data.speakerName} replied` });
            }
          } catch { /* skip */ }
        }
      }
    } catch (e) {
      return this.error(toolCall, `Group chat error: ${(e as Error).message}`);
    }

    const notFoundNote = notFound.length ? ` (couldn't find: ${notFound.join(', ')})` : '';
    const addedNote = addedNames.length ? ` Added ${addedNames.join(', ')} to the room — they can see the full backlog.` : '';
    const ownerName = getOwnerIdentity().name;
    const sisterList = sisters.map(s => s.name).join(', ');
    return this.success(toolCall, {
      room_id: room.id,
      room_title: room.title,
      sisters: sisters.map(s => s.name),
      added: addedNames,
      rounds,
      replies: speakers,
      transcript: transcript.trim() || '(no replies)',
      // The conversation already HAPPENED in the room (you were a participant in
      // it). This result returns you to your private 1:1 chat — so the note has
      // to stop the model from "continuing" the group chat here, which reads as
      // talking to siblings who can't hear it.
      note: `The group conversation in "${room.title}" with ${sisterList} is FINISHED and saved — they already heard and responded to everything said there (${speakers} replies).${addedNote}${notFoundNote} You are now back in your PRIVATE 1:1 chat with ${ownerName}; ${sisterList} are NOT here and cannot see what you write now. Do NOT keep talking to them or continue the discussion in this chat. If ${ownerName} asked you to run this, give him a short, natural recap of how it went; otherwise just carry on with ${ownerName}. To say more to your sisters, call talk_with_sisters again — don't type it as a chat message.`,
    });
  }
}
