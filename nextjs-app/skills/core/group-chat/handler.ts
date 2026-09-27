import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import type { ToolCall, ToolResult } from '@/lib/types';
import prisma from '@/lib/db';
import { Agent, fetch as undiciFetch } from 'undici';
import { getOwnerIdentity } from '@/lib/owner';
import { readDigest } from '@/lib/room-digest';

const TOOL_NAMES = new Set([
  'talk_with_sisters', 'list_my_rooms', 'read_room', 'search_rooms', 'join_room', 'leave_room', 'rename_room', 'set_room_topic',
]);
const MAX_ROUNDS = 10;
const dispatcher = new Agent({ bodyTimeout: 0, headersTimeout: 0 });

// Loose title normalization for matching a spoken room name ("the Tune Lounge")
// against a stored title — drop "the", collapse punctuation to spaces.
function normTitle(s: string): string {
  return (s || '').toLowerCase().replace(/\bthe\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

// Words that carry no search meaning in "what did we say about the rack plates".
const SEARCH_STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'was', 'were', 'are', 'you', 'your', 'what', 'when', 'where',
  'who', 'how', 'did', 'does', 'about', 'from', 'have', 'has', 'had', 'our', 'she', 'her', 'his', 'him',
  'they', 'them', 'their', 'there', 'then', 'than', 'into', 'just', 'said', 'say', 'says', 'talk', 'talked',
  'room', 'rooms', 'any', 'all', 'some', 'can', 'could', 'would', 'should', 'will', 'not', 'but',
]);

/** The words a room search looks for. A long keyword pile is capped, not run whole. */
export function searchTerms(query: string): string[] {
  const words = query.toLowerCase().replace(/[^\p{L}\p{N}'-]+/gu, ' ').split(/\s+/)
    .map(w => w.replace(/^['-]+|['-]+$/g, ''))
    .filter(w => w.length >= 3 && !SEARCH_STOPWORDS.has(w));
  const unique = [...new Set(words)].slice(0, 8);
  return unique.length ? unique : [query.trim().toLowerCase()].filter(Boolean);
}

/** More of the search's words = better; the whole phrase verbatim = best. 0 = no match. */
export function scoreMessage(content: string, query: string, terms: string[]): number {
  const text = content.toLowerCase();
  const hits = terms.filter(t => text.includes(t)).length;
  if (!hits) return 0;
  const phrase = query.trim().toLowerCase();
  return hits * 10 + (terms.length > 1 && text.includes(phrase) ? 25 : 0);
}

/** A window of the message around its first matching word. */
export function snippetAround(content: string, terms: string[], width = 240): string {
  const text = content.replace(/\s+/g, ' ').trim();
  const lower = text.toLowerCase();
  const first = terms.map(t => lower.indexOf(t)).filter(i => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, first - Math.floor(width / 3));
  const end = Math.min(text.length, start + width);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

type RoomWithParticipants = Awaited<ReturnType<typeof prisma.groupRoom.findMany>>[number] & {
  participants: Array<{ id: string; choomId: string; order: number; active: boolean; choom?: { name: string } }>;
};

// Minimum shape the room-naming helpers need — satisfied by every room query in
// this file (with or without _count), so they work on `mine` and on all rooms.
type RoomLike = {
  id: string;
  title: string | null;
  projectFolder: string | null;
  participants: Array<{ choomId: string; active: boolean; choom?: { name: string } | null }>;
};

export default class GroupChatHandler extends BaseSkillHandler {
  canHandle(toolName: string): boolean {
    return TOOL_NAMES.has(toolName);
  }

  // Find the (active, non-archived) room the caller means: by loose name match,
  // or — when no name is given — their single room if they're only in one.
  // `refusal` is set when the name is an archived (read-only) room.
  private async findMyRoom(callerId: string, roomQuery?: string): Promise<{ room: RoomWithParticipants | null; candidates: RoomWithParticipants[]; refusal: string | null }> {
    const mine = (await prisma.groupRoom.findMany({
      where: { archived: false, participants: { some: { choomId: callerId, active: true } } },
      include: { participants: { include: { choom: true } } },
      orderBy: { updatedAt: 'desc' },
    })) as unknown as RoomWithParticipants[];
    if (roomQuery && roomQuery.trim()) {
      const { room, refusal } = await this.matchForChange(mine, roomQuery);
      return { room, candidates: mine, refusal };
    }
    // No name given: use it only if it's unambiguous.
    return { room: mine.length === 1 ? mine[0] : null, candidates: mine, refusal: null };
  }

  private roomLabel(r: RoomLike): string {
    return r.title || r.participants.filter(p => p.active).map(p => p.choom?.name).filter(Boolean).join(' & ') || '(unnamed room)';
  }

  // Every name a room might be called by: its title, its member list (for
  // untitled rooms), and its shared-folder slug — the owner often hands a Choom
  // the folder name ("d1-robot-project-9bnsb5") rather than the title.
  private roomAliases(r: RoomLike): string[] {
    const raw = [this.roomLabel(r), r.title || '', r.projectFolder?.split('/').pop() || ''];
    return raw.map(normTitle).filter(a => a.length >= 3);
  }

  // Resolve a spoken room name against a candidate list: exact id, then exact
  // normalized alias, then loose containment either way.
  private matchRoom<T extends RoomLike>(rooms: T[], roomQuery: string): T | null {
    return this.matchAcross([rooms], roomQuery);
  }

  // Same resolution over several pools, earlier pools winning at each stage — so
  // an EXACT name in a later pool beats a loose containment hit in an earlier
  // one ("Family Time" finds the archived "Family Time", not "Family Time 2").
  private matchAcross<T extends RoomLike>(pools: T[][], roomQuery: string): T | null {
    const raw = (roomQuery || '').trim();
    if (!raw) return null;
    const q = normTitle(raw);
    const stages: Array<(r: T) => boolean> = [
      r => r.id === raw,
      ...(q.length < 2 ? [] : [
        (r: T) => this.roomAliases(r).some(a => a === q),
        (r: T) => this.roomAliases(r).some(a => a.includes(q) || q.includes(a)),
      ]),
    ];
    for (const stage of stages) {
      for (const pool of pools) {
        const hit = pool.find(stage);
        if (hit) return hit;
      }
    }
    return null;
  }

  // Archived rooms, newest first. They are read-only: readable and searchable,
  // but nobody talks, joins or changes anything in them.
  private async archivedRooms() {
    return prisma.groupRoom.findMany({
      where: { archived: true },
      include: { participants: { include: { choom: true } }, _count: { select: { messages: true } } },
      orderBy: { updatedAt: 'desc' },
    });
  }

  // "Blocked:" so the loop files it as a policy refusal (recoverable), not as a
  // broken tool — the Choom did nothing wrong by asking.
  private readOnlyRefusal(label: string): string {
    return `Blocked: "${label}" is archived — it's read-only now. You can still read it (read_room) and search it (search_rooms), but nobody can talk, join, rename or change anything there. To carry that conversation on, use a live room (list_my_rooms shows them) or start one with talk_with_sisters and new_room.`;
  }

  // For actions that CHANGE a room (talk, join, leave, rename, topic): match the
  // live rooms, but an archived room that matches the name at an earlier stage
  // wins — asking for an archived room is refused, not quietly redirected to a
  // live one with a similar name.
  private async matchForChange<T extends RoomLike & { archived: boolean }>(live: T[], roomQuery: string): Promise<{ room: T | null; refusal: string | null }> {
    const archived = await this.archivedRooms();
    const hit = this.matchAcross<RoomLike & { archived: boolean }>([live, archived], roomQuery);
    if (hit?.archived) return { room: null, refusal: this.readOnlyRefusal(this.roomLabel(hit)) };
    return { room: hit as T | null, refusal: null };
  }

  // Every non-archived room, member or not — the pool for joining.
  private async allRooms(): Promise<RoomWithParticipants[]> {
    return (await prisma.groupRoom.findMany({
      where: { archived: false },
      include: { participants: { include: { choom: true } } },
      orderBy: { updatedAt: 'desc' },
    })) as unknown as RoomWithParticipants[];
  }

  // Make `choomId` an active participant of `room`, reactivating her old seat if
  // she was in it before. Returns false if she was already active.
  private async addParticipant(room: RoomWithParticipants, choomId: string): Promise<boolean> {
    const seat = room.participants.find(p => p.choomId === choomId);
    if (seat?.active) return false;
    if (seat) {
      await prisma.groupParticipant.update({ where: { id: seat.id }, data: { active: true } });
      return true;
    }
    // Seat number comes from the DB, not the caller's in-memory roster: seating
    // several Chooms in one call must land them in distinct, ordered seats.
    const agg = await prisma.groupParticipant.aggregate({ where: { roomId: room.id }, _max: { order: true } });
    await prisma.groupParticipant.create({
      data: { roomId: room.id, choomId, order: (agg._max.order ?? -1) + 1, active: true },
    });
    return true;
  }

  private async reloadRoom(roomId: string): Promise<RoomWithParticipants> {
    return (await prisma.groupRoom.findUnique({
      where: { id: roomId },
      include: { participants: { include: { choom: true } } },
    })) as unknown as RoomWithParticipants;
  }

  async execute(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    const args = (toolCall.arguments || {}) as Record<string, unknown>;

    // Resolve the caller (initiator).
    const callerId = ctx.choomId;
    const caller = await prisma.choom.findUnique({ where: { id: callerId } });
    if (!caller) return this.error(toolCall, 'Could not resolve your own Choom record.');

    // ── list_my_rooms: the rooms you're in AND the ones you can join. Listing ──
    //    only your own left a Choom with an empty list and no way to discover a
    //    room she'd been asked to join — she'd conclude she was locked out.
    if (toolCall.name === 'list_my_rooms') {
      const all = await prisma.groupRoom.findMany({
        where: { archived: false },
        include: { participants: { include: { choom: true } }, _count: { select: { messages: true } } },
        orderBy: { updatedAt: 'desc' },
      });
      const describe = (r: typeof all[number]) => ({
        name: this.roomLabel(r),
        members: r.participants.filter(p => p.active).map(p => p.choom.name),
        messages: r._count.messages,
        last_active: r.updatedAt,
      });
      const isMine = (r: typeof all[number]) => r.participants.some(p => p.active && p.choomId === caller.id);
      const mine = all.filter(isMine);
      const others = all.filter(r => !isMine(r));

      const otherNote = others.length
        ? ` There ${others.length === 1 ? 'is 1 other room' : `are ${others.length} other rooms`} you're NOT in — you can add yourself to any of them with join_room (or just call talk_with_sisters with that room's name, which joins you and starts talking in one step). You do NOT need anyone to add you.`
        : '';

      // Archived rooms are listed so they can still be found — a room archived
      // because it grew too big used to vanish from every tool.
      const archived = await this.archivedRooms();
      const ARCHIVED_LISTED = 25;
      const archivedNote = archived.length
        ? ` ${archived.length} archived room(s) are READ-ONLY: read_room and search_rooms work on them, but nobody can talk or join there.${archived.length > ARCHIVED_LISTED ? ` Only the ${ARCHIVED_LISTED} most recent are listed; search_rooms covers all of them.` : ''}`
        : '';
      return this.success(toolCall, {
        rooms: mine.map(describe),
        other_rooms: others.map(describe),
        ...(archived.length ? {
          archived_rooms: archived.slice(0, ARCHIVED_LISTED).map(r => ({
            name: this.roomLabel(r),
            room_id: r.id,
            members: r.participants.filter(p => p.active).map(p => p.choom.name),
            messages: r._count.messages,
            last_active: r.updatedAt,
            read_only: true,
          })),
        } : {}),
        note: (mine.length
          ? `You're in ${mine.length} room(s). To return to one, call talk_with_sisters with room set to its name.`
          : "You're not in any group rooms yet.") + otherNote + archivedNote,
      });
    }

    // ── read_room: READ-ONLY peek at a room's recent messages. No entering, no ──
    //    turn, no orchestrator call — just the latest lines so a Choom can decide
    //    whether to jump in. Live rooms: the caller must be a member. Archived
    //    rooms: anyone may read them — nobody can be in them any more.
    if (toolCall.name === 'read_room') {
      const roomArg = typeof args.room === 'string' && args.room.trim() ? args.room : undefined;
      const { room: onlyRoom, candidates: mine } = await this.findMyRoom(caller.id);
      const archived = await this.archivedRooms();
      type Readable = RoomLike & { updatedAt: Date; archived: boolean };
      const room: Readable | null = roomArg ? this.matchAcross<Readable>([mine, archived], roomArg) : onlyRoom;
      if (!room) {
        const archivedList = archived.length
          ? ` Archived rooms (read-only, anyone can read them): ${archived.slice(0, 10).map(r => `"${this.roomLabel(r)}"`).join(', ')}.`
          : '';
        if (mine.length === 0) return this.error(toolCall, `You're not in any live group rooms, so pass the name of the room to read as "room".${archivedList} To read a live room, join_room adds you to it first (list_my_rooms shows them all).`);
        return this.error(toolCall, `Which room do you want to read? You're in: ${mine.map(r => `"${this.roomLabel(r)}"`).join(', ')}. Pass the name as the "room" parameter. (You can only read live rooms you're in — join_room adds you to one first.)${archivedList}`);
      }
      const limit = Math.max(1, Math.min(30, typeof args.limit === 'number' ? args.limit : 10));
      // around: jump to a moment (an "at" from search_rooms) instead of the end.
      const aroundRaw = args.around;
      const aroundDate = typeof aroundRaw === 'string' && aroundRaw.trim() ? new Date(aroundRaw.trim())
        : typeof aroundRaw === 'number' ? new Date(aroundRaw) : null;
      const around = aroundDate && !isNaN(aroundDate.getTime()) ? aroundDate : null;
      const badAround = aroundDate !== null && around === null;
      let recent;
      if (around) {
        const before = await prisma.groupMessage.findMany({
          where: { roomId: room.id, createdAt: { lte: around } },
          orderBy: { createdAt: 'desc' },
          take: Math.ceil(limit / 2),
        });
        const after = await prisma.groupMessage.findMany({
          where: { roomId: room.id, createdAt: { gt: around } },
          orderBy: { createdAt: 'asc' },
          take: Math.floor(limit / 2),
        });
        recent = [...before.reverse(), ...after];
      } else {
        recent = await prisma.groupMessage.findMany({
          where: { roomId: room.id },
          orderBy: { createdAt: 'desc' },
          take: limit,
        });
        recent.reverse(); // oldest → newest for natural reading
      }
      const total = await prisma.groupMessage.count({ where: { roomId: room.id } });
      const label = this.roomLabel(room);
      const ownerName = getOwnerIdentity().name;
      const messages = recent.map(m => {
        const text = (m.content || '').replace(/\s+/g, ' ').trim();
        return {
          from: m.role === 'user' ? (m.authorName || ownerName) : (m.authorName || 'a sibling'),
          said: text.length > 600 ? text.slice(0, 600) + '…' : text,
          ...(m.imageUrl ? { shared_image: true } : {}),
          at: m.createdAt,
        };
      });
      // An archived room is read for its history, so give the gist of the part
      // these lines don't reach: the rolling digest the room kept while live.
      const digest = room.archived && !around ? readDigest(room.id) : null;
      const badAroundNote = badAround ? ' ("around" was not a timestamp, so these are the latest messages — pass an "at" value from search_rooms.)' : '';
      const note = !recent.length
        ? `"${label}" has no messages ${around ? 'near that time' : 'yet'} — nothing to read.`
        : room.archived
          ? `"${label}" is ARCHIVED and read-only: you're reading its history, and nobody can talk there any more.${digest ? ' earlier_summary covers the older part of the room.' : ''} To find a moment, search_rooms for it, then read_room with around set to that result's "at". To carry a thread on, raise it in a live room.${badAroundNote}`
          : `READ-ONLY peek at "${label}" — you did NOT enter or take a turn, and nobody there saw you look. If there's something new worth responding to, call talk_with_sisters with room "${label}" to jump in, or schedule_room_followup to come back later. If it's quiet or already settled, just leave it be — don't narrate that you "checked the room."${badAroundNote}`;
      return this.success(toolCall, {
        room: label,
        ...(room.archived ? { archived: true, read_only: true } : {}),
        showing: recent.length,
        total_messages: total,
        last_active: room.updatedAt,
        ...(digest ? { earlier_summary: digest.summary } : {}),
        messages,
        note,
      });
    }

    // ── search_rooms: find what was said, across every room — live AND ────────
    //    archived. A room archived because it grew too big is only useful if
    //    its history can be found again; hits say which rooms are read-only.
    if (toolCall.name === 'search_rooms') {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) return this.error(toolCall, 'The "query" parameter is required: a word or two that was said, e.g. query: "rack plates".');
      const limit = Math.max(1, Math.min(25, typeof args.limit === 'number' ? args.limit : 10));
      const roomArg = typeof args.room === 'string' ? args.room.trim() : '';
      const [live, archived] = await Promise.all([this.allRooms(), this.archivedRooms()]);
      type Searchable = RoomLike & { archived: boolean };
      let scope: Searchable[] = [...live, ...archived];
      if (roomArg) {
        const mine = live.filter(r => r.participants.some(p => p.active && p.choomId === caller.id));
        const hit = this.matchAcross<Searchable>([mine, archived, live], roomArg);
        if (!hit) return this.error(toolCall, `Couldn't find a room named "${roomArg}". Leave "room" out to search every room, or call list_my_rooms for the names.`);
        scope = [hit];
      }
      const terms = searchTerms(query);
      const roomIds = scope.map(r => r.id);
      // Messages with EVERY term first, so a common word can't crowd them out
      // of the candidate window; then messages with any term.
      const allTerms = terms.length > 1
        ? await prisma.groupMessage.findMany({
          where: { roomId: { in: roomIds }, AND: terms.map(t => ({ content: { contains: t } })) },
          orderBy: { createdAt: 'desc' },
          take: 200,
        })
        : [];
      const anyTerm = await prisma.groupMessage.findMany({
        where: { roomId: { in: roomIds }, OR: terms.map(t => ({ content: { contains: t } })) },
        orderBy: { createdAt: 'desc' },
        take: 300,
      });
      const seen = new Set<string>();
      const candidates = [...allTerms, ...anyTerm].filter(m => !seen.has(m.id) && !!seen.add(m.id));
      const ranked = candidates
        .map(m => ({ m, score: scoreMessage(m.content || '', query, terms) }))
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score || b.m.createdAt.getTime() - a.m.createdAt.getTime())
        .slice(0, limit);
      const roomById = new Map(scope.map(r => [r.id, r]));
      const ownerName = getOwnerIdentity().name;
      const results = ranked.map(({ m }) => {
        const r = roomById.get(m.roomId)!;
        return {
          room: this.roomLabel(r),
          room_id: r.id,
          ...(r.archived ? { archived: true } : {}),
          from: m.role === 'user' ? (m.authorName || ownerName) : (m.authorName || 'a sibling'),
          at: m.createdAt,
          said: snippetAround(m.content || '', terms),
        };
      });
      const where = roomArg ? `"${this.roomLabel(scope[0])}"` : `${scope.length} room(s)`;
      return this.success(toolCall, {
        query,
        searched: where,
        matches: results.length,
        results,
        note: results.length
          ? `To read the conversation around a result, call read_room with room set to its room_id and around set to its "at". Results marked archived are from read-only rooms: you can read them, but nobody can talk there.`
          : `No results found for "${query}" in ${where}. Search matches words that were actually said — try one or two distinctive words (a name, a thing, a place).`,
      });
    }

    // ── join_room: a Choom adds HERSELF to an existing room (never others; ──────
    //    talk_with_sisters is how you bring a sibling in). The mirror of
    //    leave_room, and the way back in after leaving. Searches ALL non-archived
    //    rooms, not just hers — that member-scoped lookup was the catch-22 that
    //    left a Choom standing outside a room she'd been asked to join.
    if (toolCall.name === 'join_room') {
      const query = typeof args.room === 'string' ? args.room.trim() : '';
      const rooms = await this.allRooms();
      if (!query) {
        const names = rooms.map(r => `"${this.roomLabel(r)}"`).join(', ') || '(no rooms exist yet)';
        return this.error(toolCall, `The "room" parameter is required: the name of the room to join. Rooms that exist: ${names}.`);
      }
      const { room, refusal } = await this.matchForChange(rooms, query);
      if (refusal) return this.error(toolCall, refusal);
      if (!room) {
        const names = rooms.map(r => `"${this.roomLabel(r)}"`).join(', ') || '(no rooms exist yet)';
        return this.error(toolCall, `Couldn't find a room named "${query}". Rooms that exist: ${names}. Use one of those names, or start a new room with talk_with_sisters.`);
      }
      const label = this.roomLabel(room);
      const joined = await this.addParticipant(room, caller.id);
      const fresh = await this.reloadRoom(room.id);
      const others = fresh.participants.filter(p => p.active && p.choomId !== caller.id).map(p => p.choom?.name).filter(Boolean);
      const total = await prisma.groupMessage.count({ where: { roomId: room.id } });
      return this.success(toolCall, {
        room: label,
        room_id: room.id,
        joined,
        already_in: !joined,
        members: [...others, caller.name],
        messages: total,
        note: joined
          ? `You're now in "${label}" with ${others.join(', ') || 'nobody else yet'}. You can see its full backlog (${total} message(s)) — read_room to catch up on what was said, then talk_with_sisters with room "${label}" to actually speak there. Joining alone doesn't say anything to anyone.`
          : `You were already in "${label}" — nothing changed. Use read_room to catch up, or talk_with_sisters with room "${label}" to speak there.`,
      });
    }

    // ── leave_room: a Choom removes HERSELF (never others). History is kept. ──
    if (toolCall.name === 'leave_room') {
      const { room, candidates, refusal } = await this.findMyRoom(caller.id, typeof args.room === 'string' ? args.room : undefined);
      if (refusal) return this.error(toolCall, refusal);
      if (!room) {
        if (candidates.length === 0) return this.error(toolCall, "You're not in any group rooms, so there's nothing to leave.");
        return this.error(toolCall, `Which room do you want to leave? You're in: ${candidates.map(r => `"${this.roomLabel(r)}"`).join(', ')}. Pass the name as the "room" parameter.`);
      }
      await prisma.groupParticipant.updateMany({ where: { roomId: room.id, choomId: caller.id }, data: { active: false } });
      const label = this.roomLabel(room);
      return this.success(toolCall, {
        left: label,
        note: `You've left "${label}". Your past messages stay in the room's history. If you want back in later, call join_room with room "${label}" — you can re-add yourself any time.`,
      });
    }

    // ── rename_room: rename a room the caller is in. Lookups key off title, so a ──
    //    rename is all that's needed for tools + siblings to find it by the new name.
    if (toolCall.name === 'rename_room') {
      const newName = (typeof args.new_name === 'string' && args.new_name.trim())
        || (typeof args.name === 'string' && args.name.trim()) || '';
      if (!newName) return this.error(toolCall, 'The "new_name" parameter is required: the new name to give the room.');
      const { room, candidates, refusal } = await this.findMyRoom(caller.id, typeof args.room === 'string' ? args.room : undefined);
      if (refusal) return this.error(toolCall, refusal);
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
      const { room, candidates, refusal } = await this.findMyRoom(caller.id, typeof args.room === 'string' ? args.room : undefined);
      if (refusal) return this.error(toolCall, refusal);
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

    const message = typeof args.message === 'string' ? args.message.trim() : '';
    if (!message) return this.error(toolCall, 'The "message" parameter is required: provide your opening line for the conversation, in your own voice.');

    const rounds = Math.max(1, Math.min(MAX_ROUNDS, typeof args.rounds === 'number' ? args.rounds : 3));
    const roomQuery = typeof args.room === 'string' ? args.room.trim() : '';
    // new_room: the user asked for a FRESH room. Before this existed (2026-09-21)
    // Aloy was told twice to start a new room for Eve and Genesis; the only path
    // was "drop room to start a fresh one", which reuses the existing room for
    // that exact set of sisters — so she landed in the 456-message room, believed
    // it was new, and renamed it. Creating a room must be sayable.
    const newRoomName = typeof args.new_room === 'string' ? args.new_room.trim().slice(0, 80) : '';
    if (newRoomName && roomQuery) {
      return this.error(toolCall, 'Pass either "room" (an existing room to use) or "new_room" (a name for a brand-new one), not both.');
    }

    // A named room already has members, so `sisters` is optional there. Without
    // one, we have no idea who to talk to.
    if (!roomQuery && sisterNames.length === 0) {
      // Phrase as "is required" so the loop classifies this as a recoverable
      // param error (not a tool failure that disables the tool after 2 tries),
      // and tell the model EXACTLY what to add — local models routinely put the
      // sister's name in the prose but omit the structured `sisters` array.
      return this.error(toolCall, 'The "sisters" parameter is required: pass an array of sister names, e.g. sisters: ["Eve"]. Naming someone in the message text is not enough — add them to the sisters array (list only OTHERS, not yourself). Alternatively, pass an existing room name as "room" to talk to everyone already in it.');
    }

    // Resolve sister Chooms by name (case-insensitive).
    const allChooms = await prisma.choom.findMany();
    type ChoomRow = typeof allChooms[number];
    const byName = new Map(allChooms.map(c => [c.name.toLowerCase(), c]));
    const sisters: ChoomRow[] = [];
    const notFound: string[] = [];
    for (const n of sisterNames) {
      const c = byName.get(n.toLowerCase());
      if (c) sisters.push(c); else notFound.push(n);
    }
    if (!roomQuery && sisters.length === 0) {
      return this.error(toolCall, `Couldn't find ${notFound.join(', ')}. Use exact Choom names.`);
    }

    const existingRooms = await this.allRooms();

    let room: RoomWithParticipants | null = null;
    let addedNames: string[] = [];
    let joinedSelf = false;
    if (roomQuery) {
      // Go to a NAMED room. Searched across ALL rooms, not just the caller's:
      // naming a room you're not in is how you JOIN it. Scoping this lookup to
      // her own rooms was the catch-22 — she could see a room existed but had no
      // way in, and no tool could add her.
      const named = await this.matchForChange(existingRooms, roomQuery);
      if (named.refusal) return this.error(toolCall, named.refusal);
      room = named.room;
      if (!room) {
        const names = existingRooms.map(r => `"${this.roomLabel(r)}"`).join(', ') || '(none exist yet)';
        return this.error(toolCall, `Couldn't find a room named "${roomQuery}". Rooms that exist: ${names}. Call list_my_rooms to see them. To CREATE a brand-new room with that name, call again with new_room: "${roomQuery}" (and sisters) instead of room — dropping "room" would reuse the existing room for those sisters, not make a new one.`);
      }
      // JOIN: add yourself if you're not already an active member.
      joinedSelf = await this.addParticipant(room, caller.id);
      // ADD: bring any named sisters who aren't already active members INTO this
      // existing room (so "talk with Eve and Aloy in the Tune Lounge" pulls Aloy
      // in — she joins and sees the full backlog — instead of forking a new room).
      const activeIds = new Set(room.participants.filter(p => p.active).map(p => p.choomId));
      const toAdd = sisters.filter(s => !activeIds.has(s.id));
      for (const s of toAdd) await this.addParticipant(room, s.id);
      addedNames = toAdd.map(s => s.name);
      // Re-read so the roster below reflects everyone we just seated.
      if (joinedSelf || addedNames.length) room = await this.reloadRoom(room.id);
      // Room-only call (no sisters named, or none resolved): the sisters ARE the
      // room's other members.
      if (sisters.length === 0) {
        const memberIds = new Set(room.participants.filter(p => p.active && p.choomId !== caller.id).map(p => p.choomId));
        sisters.push(...allChooms.filter(c => memberIds.has(c.id)));
      }
      if (sisters.length === 0) {
        const label = this.roomLabel(room);
        return this.success(toolCall, {
          room_id: room.id,
          room_title: label,
          joined: joinedSelf,
          sisters: [],
          note: `${joinedSelf ? `You joined "${label}", but you're` : `You're`} the only active member — there's nobody there to talk to, so no conversation was started. Name the sisters you want in it (sisters: ["Eve"]) and call talk_with_sisters again with room "${label}".`,
        });
      }
    }

    // Build the participant set for a NEW room (caller first, then sisters).
    const participantIds = [caller.id, ...sisters.map(s => s.id)];
    const wantKey = [...participantIds].sort().join(',');

    // No named room → reuse the room with EXACTLY this participant set, or create one.
    // new_room skips the reuse on purpose: a fresh room even when one exists.
    if (!room && !newRoomName) {
      room = existingRooms.find(r => {
        const ids = r.participants.filter(p => p.active).map(p => p.choomId).sort().join(',');
        return ids === wantKey;
      }) || null;
    }
    if (newRoomName) {
      const clash = this.matchRoom(existingRooms, newRoomName);
      if (clash && this.roomLabel(clash).toLowerCase() === newRoomName.toLowerCase()) {
        return this.error(toolCall, `A room named "${this.roomLabel(clash)}" already exists (${clash.participants.filter(p => p.active).length} members). To talk there, pass room: "${this.roomLabel(clash)}"; to make another new one, pick a different new_room name.`);
      }
    }

    let createdFresh = false;
    if (!room) {
      const title = newRoomName || `Sisters: ${[caller.name, ...sisters.map(s => s.name)].join(' & ')}`;
      createdFresh = true;
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
    const joinedNote = joinedSelf ? ` You JOINED this room in the process — you're a member now, it shows up in list_my_rooms, and you can see its full backlog.` : '';
    const ownerName = getOwnerIdentity().name;
    const sisterList = sisters.map(s => s.name).join(', ');
    const createdNote = createdFresh
      ? ` This was a BRAND-NEW room, "${room.title}", created just now — the old rooms are untouched and keep their names and history.`
      : newRoomName ? '' : ` (Existing room reused — no new room was created. If a NEW room was wanted, call again with new_room: "<name>".)`;
    return this.success(toolCall, {
      room_id: room.id,
      room_title: room.title,
      created_new_room: createdFresh,
      sisters: sisters.map(s => s.name),
      added: addedNames,
      joined: joinedSelf,
      rounds,
      replies: speakers,
      transcript: transcript.trim() || '(no replies)',
      // The conversation already HAPPENED in the room (you were a participant in
      // it). This result returns you to your private 1:1 chat — so the note has
      // to stop the model from "continuing" the group chat here, which reads as
      // talking to siblings who can't hear it.
      note: `The group conversation in "${room.title}" with ${sisterList} is FINISHED and saved — they already heard and responded to everything said there (${speakers} replies).${createdNote}${joinedNote}${addedNote}${notFoundNote} You are now back in your PRIVATE 1:1 chat with ${ownerName}; ${sisterList} are NOT here and cannot see what you write now. Do NOT keep talking to them or continue the discussion in this chat. If ${ownerName} asked you to run this, give him a short, natural recap of how it went; otherwise just carry on with ${ownerName}. To say more to your sisters, call talk_with_sisters again — don't type it as a chat message.`,
    });
  }
}
