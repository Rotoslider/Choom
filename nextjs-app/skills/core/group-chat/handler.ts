import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import type { ToolCall, ToolResult } from '@/lib/types';
import prisma from '@/lib/db';
import { Agent, fetch as undiciFetch } from 'undici';

const TOOL_NAMES = new Set(['talk_with_sisters', 'list_my_rooms']);
const MAX_ROUNDS = 10;
const dispatcher = new Agent({ bodyTimeout: 0, headersTimeout: 0 });

export default class GroupChatHandler extends BaseSkillHandler {
  canHandle(toolName: string): boolean {
    return TOOL_NAMES.has(toolName);
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
    const existingRooms = await prisma.groupRoom.findMany({
      where: { archived: false },
      include: { participants: true },
    });

    let room: (typeof existingRooms)[number] | null = null;
    const roomQuery = typeof args.room === 'string' ? args.room.trim().toLowerCase() : '';
    if (roomQuery) {
      // Return to a NAMED room the caller is in (e.g. "the lounge"). Match the
      // title loosely (ignore filler words like "the").
      const q = roomQuery.replace(/\bthe\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
      const mine = existingRooms.filter(r => r.participants.some(p => p.active && p.choomId === caller.id));
      room = mine.find(r => {
        const t = (r.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        return t && (t.includes(q) || q.includes(t));
      }) || null;
      if (!room) {
        const names = mine.map(r => r.title).filter(Boolean).join(', ') || '(none)';
        return this.error(toolCall, `Couldn't find a room named "${args.room}" that you're in. Your rooms: ${names}. Call list_my_rooms to see them.`);
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
      room = await prisma.groupRoom.update({ where: { id: created.id }, data: { projectFolder }, include: { participants: true } });
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
        }),
        dispatcher,
      });
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

    const note = notFound.length ? ` (couldn't find: ${notFound.join(', ')})` : '';
    return this.success(toolCall, {
      room_id: room.id,
      room_title: room.title,
      sisters: sisters.map(s => s.name),
      rounds,
      replies: speakers,
      transcript: transcript.trim() || '(no replies)',
      note: `You talked with ${sisters.map(s => s.name).join(', ')} in the room "${room.title}". ${speakers} replies over up to ${rounds} rounds.${note} The user can see and join this conversation in the Group Rooms view.`,
    });
  }
}
