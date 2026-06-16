import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import prisma from '@/lib/db';
import { WORKSPACE_ROOT } from '@/lib/config';
import {
  runSpeakerTurn,
  type GroupTranscriptEntry,
  type GroupSend,
} from '@/lib/group-chat-runner';
import { getOwnerIdentity } from '@/lib/owner';

const baseUrl = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
const TURN_TIMEOUT_MS = 300000; // per-speaker wait ceiling

// ── Per-room run lock (in-process) ─────────────────────────────────────────
// Every orchestration — whether kicked off from the web /rooms page, a Choom's
// talk_with_sisters tool, or a Signal "group:" turn — funnels through THIS route
// in the single Next.js server process. A module-level lock therefore stops the
// same room from running twice at once. This is exactly the bug that hit the
// first live test: a Choom's heartbeat fired while the user had also triggered
// talk_with_sisters, so the room ran in full TWICE. Keyed by roomId.
const runningRooms = new Map<string, number>(); // roomId -> startedAt (ms)
const lastRunAt = new Map<string, number>();     // roomId -> finishedAt (ms)
const RUN_LOCK_STALE_MS = 15 * 60 * 1000; // auto-release a crashed/abandoned run
// A Choom-initiated run (heartbeat / self-wakeup) within this window of the last
// run on the same room is treated as an accidental duplicate and skipped — covers
// the case where the second trigger lands just AFTER the first finishes.
const INITIATOR_COOLDOWN_MS = 90 * 1000;
// Only the most recent N messages are fed to each speaker as context. Keeps a
// long-lived "lounge" room from bloating the local model's context window (and
// the room itself persists fully on disk + in the UI regardless).
// Recent messages fed to each speaker. Kept deliberately modest: a long room of
// verbose turns blew past 200k tokens at 50, which degraded the small local model
// (qwen3.6-35b-a3b) into losing its own identity (speaking as a sibling) and
// echoing. The room persists fully on disk regardless — this only bounds what the
// model sees per turn. ~24 keeps several rounds of continuity without the bloat.
const TRANSCRIPT_WINDOW = 24;

// Auto-save an image a Choom generated into the shared room folder so it
// persists with the conversation and siblings can analyze_image it. Returns the
// workspace-relative path, or null on failure. Chooms no longer need to call
// save_generated_image themselves (and used to claim they had without doing it).
function saveRoomImage(projectFolder: string | null, choomName: string, dataUrl: string, idHint: string): string | null {
  if (!projectFolder || !dataUrl?.startsWith('data:image')) return null;
  try {
    const m = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/s);
    if (!m) return null;
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const slug = choomName.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const rel = path.join(projectFolder, 'images', `${slug}-${idHint.slice(-8)}.${ext}`);
    const abs = path.join(WORKSPACE_ROOT, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.from(m[2], 'base64'));
    return rel;
  } catch (e) {
    console.warn('saveRoomImage failed:', (e as Error).message);
    return null;
  }
}

// Ensure a participant has a scratch Chat row (FK anchor for /api/chat group
// turns — its history is never read in group mode). Created lazily, reused.
async function ensureScratchChat(participant: { id: string; choomId: string; scratchChatId: string | null }): Promise<string> {
  if (participant.scratchChatId) {
    const existing = await prisma.chat.findUnique({ where: { id: participant.scratchChatId } });
    if (existing) return participant.scratchChatId;
  }
  const chat = await prisma.chat.create({
    data: { choomId: participant.choomId, title: '[group scratch]', archived: true },
  });
  await prisma.groupParticipant.update({ where: { id: participant.id }, data: { scratchChatId: chat.id } });
  return chat.id;
}

// Find which participants the user explicitly addressed. Matches "@Name",
// "Name:" / "Name," leading address, or a whole-word name anywhere in the
// message. Returns matched choomIds (empty = address everyone).
function detectMentions(message: string, participants: Array<{ choomId: string; name: string }>): Set<string> {
  const matched = new Set<string>();
  const lower = message.toLowerCase();
  for (const p of participants) {
    const n = p.name.toLowerCase();
    if (n.length < 2) continue;
    const wordRe = new RegExp(`(^|[^a-z0-9])@?${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
    if (wordRe.test(lower)) matched.add(p.choomId);
  }
  return matched;
}

// Human-readable provenance for "how this room conversation started" — logged to
// the room's ActivityLog so the owner can see the PATH each run took.
function activationLabel(source: string | undefined | null, continueRun: boolean): string {
  if (continueRun) return 'continued the conversation (keep going)';
  switch (source) {
    case 'heartbeat': return 'started a conversation during a heartbeat';
    case 'room_followup': return 'returned via a scheduled room follow-up';
    case 'chat': return 'started a conversation from a 1:1 chat';
    case 'signal': return 'started a conversation from Signal';
    case 'user': return 'opened the room';
    default: return 'started a conversation';
  }
}

export async function POST(request: NextRequest) {
  const encoder = new TextEncoder();
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const roomId = body.roomId as string;
  const message = body.message as string;
  const settings = body.settings;
  const ownerName = (body.ownerName as string)?.trim() || getOwnerIdentity().name;
  const imageUrl = (body.imageUrl as string) || null; // optional user-shared image (data URL)
  // Keep-going: run more rounds over the existing transcript WITHOUT a new user
  // message (the "Keep going" button). roundsOverride caps how many.
  const continueRun = !!body.continue;
  const roundsOverride = typeof body.rounds === 'number' ? body.rounds : undefined;
  // Choom-initiated chat (the `talk_with_sisters` tool): the opening line comes
  // from a Choom, not the user. Saved as that Choom's line; round-0 speakers are
  // the OTHER participants reacting to it.
  const initiatorChoomId = (body.initiatorChoomId as string) || null;

  if (!roomId || (!message && !continueRun)) {
    return new Response(JSON.stringify({ error: 'roomId and message are required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const room = await prisma.groupRoom.findUnique({
    where: { id: roomId },
    include: { participants: { include: { choom: true }, orderBy: { order: 'asc' } } },
  });
  if (!room) {
    return new Response(JSON.stringify({ error: 'Room not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }

  const activeParticipants = room.participants.filter(p => p.active);
  if (activeParticipants.length === 0) {
    return new Response(JSON.stringify({ error: 'Room has no active participants' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  // Pinned room topic (one-liner injected into every turn). Read via raw SQL so
  // it works without a Prisma client regeneration for the new `topic` column.
  let roomTopic: string | undefined;
  try {
    const rows = await prisma.$queryRaw<Array<{ topic: string | null }>>`SELECT topic FROM GroupRoom WHERE id = ${roomId}`;
    roomTopic = rows?.[0]?.topic || undefined;
  } catch { /* topic column optional */ }

  const participantNames = activeParticipants.map(p => p.choom.name);
  const initiator = initiatorChoomId ? activeParticipants.find(p => p.choomId === initiatorChoomId) : null;

  // ── Acquire the per-room run lock (prevents the same room running twice) ──
  const nowMs = Date.now();
  const runningSince = runningRooms.get(roomId);
  if (runningSince && nowMs - runningSince < RUN_LOCK_STALE_MS) {
    return new Response(
      JSON.stringify({ busy: true, error: 'A conversation is already in progress in this room.' }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    );
  }
  // A Choom-initiated run that lands right after a previous one finished is almost
  // certainly an accidental duplicate (e.g. a heartbeat echoing a just-run task).
  const isInitiatorRun = !!initiatorChoomId && !continueRun;
  if (isInitiatorRun) {
    const finishedAt = lastRunAt.get(roomId);
    if (finishedAt && nowMs - finishedAt < INITIATOR_COOLDOWN_MS) {
      return new Response(
        JSON.stringify({ busy: true, skipped: true, error: 'This room just had a conversation moments ago — skipping the duplicate.' }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      );
    }
  }
  runningRooms.set(roomId, nowMs);
  let lockReleased = false;
  const releaseLock = () => {
    if (lockReleased) return;
    lockReleased = true;
    runningRooms.delete(roomId);
    lastRunAt.set(roomId, Date.now());
  };

  // Provenance: record HOW a Choom-initiated run started (during a heartbeat, via
  // a scheduled follow-up, or from a 1:1) in the room's ActivityLog, so the owner
  // can see the path a room took to light up. Skipped for the owner's own messages
  // (web/Signal) and keep-going — those aren't "how the room started", just chatter.
  if (initiator && !continueRun) {
    const triggerSource = (body.triggerSource as string) || 'chat';
    void prisma.activityLog.create({
      data: {
        choomId: initiator.choomId,
        chatId: roomId,
        level: 'info',
        category: 'system',
        title: 'Room started',
        message: `${initiator.choom.name} ${activationLabel(triggerSource, continueRun)}.`,
      },
    }).catch(() => { /* logging must never break the run */ });
  }

  // Persist the opening message. Keep-going adds none; an initiating Choom's
  // opening is saved as that Choom's line; otherwise it's the user's line.
  const userMsg = continueRun ? null : await prisma.groupMessage.create({
    data: initiator
      ? { roomId, role: 'assistant', authorChoomId: initiator.choomId, authorName: initiator.choom.name, content: message, imageUrl }
      : { roomId, role: 'user', authorChoomId: null, authorName: ownerName, content: message, imageUrl },
  });

  // Load only the recent window for POV rendering (room persists fully on disk).
  const priorMessages = (await prisma.groupMessage.findMany({
    where: { roomId },
    orderBy: { createdAt: 'desc' },
    take: TRANSCRIPT_WINDOW,
  })).reverse();
  const transcript: GroupTranscriptEntry[] = priorMessages.map(m => ({
    authorChoomId: m.authorChoomId,
    authorName: m.authorName,
    content: m.content,
  }));

  // First round honors @mentions; keep-going (or no mention) = everyone speaks.
  // A Choom-initiated chat: round 0 is the OTHER participants reacting.
  const mentioned = (continueRun || initiator)
    ? new Set<string>()
    : detectMentions(message, activeParticipants.map(p => ({ choomId: p.choomId, name: p.choom.name })));
  const firstRoundSpeakers = mentioned.size > 0
    ? activeParticipants.filter(p => mentioned.has(p.choomId))
    : (initiator ? activeParticipants.filter(p => p.choomId !== initiator.choomId) : activeParticipants);

  // Set when the client disconnects (user hit Stop or sent a new message to
  // jump in). Checked between speakers so we stop the sequence promptly instead
  // of running every remaining auto-round in the background.
  let cancelled = false;
  // When a CHOOM starts a room on her own (e.g. during a self-scheduled wakeup),
  // Donny isn't watching — ping him once so he can hop into the room. Skipped for
  // owner-driven runs (he's already in /rooms) and keep-going.
  let notifiedOwner = false;
  const shouldNotifyOwner = !!initiator && !continueRun;

  const stream = new ReadableStream({
    async start(controller) {
      const send: GroupSend = (event) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch { /* stream closed */ }
      };

      try {
        if (userMsg) {
          send({ type: 'user_saved', messageId: userMsg.id, authorName: ownerName, content: message, imageUrl });
        }

        // Round cap. Keep-going honors its explicit override. A Choom-initiated
        // run honors the `rounds` the initiator asked for (round 0 = siblings
        // react to her opening, then `rounds` more full rounds) instead of the
        // room's large auto-rounds ceiling — convergence (below) usually ends it
        // sooner. Owner-driven web runs keep the room's autoRounds behavior.
        const maxRounds = continueRun
          ? Math.max(1, roundsOverride ?? room.autoRounds)
          : initiator
            ? 1 + Math.max(1, roundsOverride ?? 3)
            : 1 + Math.max(0, room.autoRounds);
        // Settle gap between consecutive turns: every Choom usually shares one
        // local model, so firing back-to-back large-context requests at the same
        // LM Studio endpoint can make it return an empty completion (KV-cache
        // churn). A short pause lets the server settle between speakers and cuts
        // down the spurious cloud fallbacks. Skipped before the very first turn.
        let priorTurnRan = false;
        for (let round = 0; round < maxRounds && !cancelled; round++) {
          // Round 0 honors mentions; auto-rounds include all active participants.
          const speakers = round === 0 ? firstRoundSpeakers : activeParticipants;
          let anySpoke = false;
          // Speakers who contributed real content AND did NOT signal they're done
          // (no trailing [PASS]). When a whole round produces zero of these, the
          // conversation has wound down — stop instead of looping filler.
          let stillEngaged = 0;

          for (const p of speakers) {
            if (cancelled) break;
            if (priorTurnRan) await new Promise(res => setTimeout(res, 800));
            priorTurnRan = true;
            const scratchChatId = await ensureScratchChat(p);
            send({
              type: 'speaker_start',
              speakerChoomId: p.choomId,
              speakerName: p.choom.name,
              avatarUrl: p.choom.avatarUrl || null,
              round,
            });

            const turnOpts = {
              baseUrl,
              choomId: p.choomId,
              speakerName: p.choom.name,
              scratchChatId,
              transcript,
              participantNames,
              projectFolder: room.projectFolder,
              roomTopic,
              roomId: room.id,
              isInitiator: !!initiator && p.choomId === initiator.choomId,
              settings,
              timeoutMs: TURN_TIMEOUT_MS,
              send,
            };
            let result = await runSpeakerTurn(turnOpts);

            // One-shot anti-echo retry: the model parroted the prompt verbatim
            // (the classic first-responder-echoes-the-greeting failure). Re-run the
            // turn once with a corrective directive so the Choom actually responds,
            // instead of saving a parrot or going silent. `retry: true` tells the
            // live view to reset its display + drop the parrot's queued audio.
            if (result.parroted && !cancelled) {
              console.log(`   🔁 [${p.choom.name}] Echoed the prompt — retrying once with anti-echo directive`);
              send({
                type: 'speaker_start',
                speakerChoomId: p.choomId,
                speakerName: p.choom.name,
                avatarUrl: p.choom.avatarUrl || null,
                round,
                retry: true,
              });
              result = await runSpeakerTurn({ ...turnOpts, antiEcho: true });
            }

            if (result.error) {
              send({ type: 'speaker_error', speakerChoomId: p.choomId, speakerName: p.choom.name, error: result.error });
              continue;
            }
            if (result.passed || !result.content) {
              send({ type: 'passed', speakerChoomId: p.choomId, speakerName: p.choom.name });
              continue;
            }

            // Auto-save any generated image into the shared room folder, so it
            // persists and siblings can analyze_image it by path next turn.
            let savedContent = result.content;
            if (result.imageUrl) {
              const idHint = result.imageId || result.imageUrl.replace(/[^a-z0-9]/gi, '').slice(-8);
              const rel = saveRoomImage(room.projectFolder, p.choom.name, result.imageUrl, idHint);
              if (rel) {
                savedContent += `\n\n_[image shared to the room — saved at \`${rel}\`. Siblings can view it with analyze_image image_path="${rel}".]_`;
              }
            }

            const saved = await prisma.groupMessage.create({
              data: {
                roomId,
                role: 'assistant',
                authorChoomId: p.choomId,
                authorName: p.choom.name,
                content: savedContent,
                imageUrl: result.imageUrl,
                toolCalls: result.toolCalls.length ? JSON.stringify(result.toolCalls) : null,
              },
            });
            // Append to the in-memory transcript so later speakers in THIS round
            // (and later rounds) see what was just said.
            transcript.push({ authorChoomId: p.choomId, authorName: p.choom.name, content: savedContent });
            anySpoke = true;
            if (!result.windingDown) stillEngaged++;

            // First real reply of a Choom-initiated run → ping Donny via Signal so
            // he knows the room lit up and can join. Fire-and-forget; never blocks.
            if (shouldNotifyOwner && !notifiedOwner) {
              notifiedOwner = true;
              const roomName = room.title || participantNames.join(' & ');
              const others = participantNames.join(' & ');
              fetch(`${baseUrl}/api/notifications`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  choomId: initiator!.choomId,
                  message: `${others} are chatting in "${roomName}". Open Group Rooms to listen in or join.`,
                  includeAudio: false,
                }),
              }).catch(() => { /* notification is best-effort */ });
            }

            send({
              type: 'speaker_done',
              speakerChoomId: p.choomId,
              speakerName: p.choom.name,
              avatarUrl: p.choom.avatarUrl || null,
              messageId: saved.id,
              content: result.content,
              imageUrl: result.imageUrl,
              voiceId: p.choom.voiceId || null,
            });
          }

          send({ type: 'round_complete', round });
          // Converged: nobody had anything to add this round → stop early.
          if (!anySpoke) break;
          // Wound down: everyone who spoke this round signaled they're done
          // (passed, or ended with [PASS]). Don't drag it through more rounds of
          // one-liners. Round 0 is the opening reaction, so only apply from
          // round 1 onward (gives the initiator at least one full round back).
          if (round >= 1 && stillEngaged === 0) break;
        }

        await prisma.groupRoom.update({ where: { id: roomId }, data: { updatedAt: new Date() } });
        send({ type: 'done' });
      } catch (err) {
        send({ type: 'error', error: (err as Error).message });
      } finally {
        releaseLock();
        try { controller.close(); } catch { /* already closed */ }
      }
    },
    cancel() {
      // Client disconnected (Stop, or sent a new message to jump in).
      cancelled = true;
      releaseLock();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
