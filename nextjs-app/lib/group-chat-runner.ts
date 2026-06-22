// Group-chat turn runner.
//
// Runs a SINGLE Choom's turn inside a group room by calling the existing
// /api/chat endpoint with the `isGroupTurn` flag (mirrors the delegation
// handler's internal SSE call). The shared transcript is rendered from the
// speaker's point of view and passed as `groupMessages`, so each turn is a
// normal agentic loop — tools, memory (companionId), workspace, and the
// folder-ownership guard all work unchanged.

import { Agent, fetch as undiciFetch } from 'undici';
import { describeRoomImages } from './room-image-describe';

// Dedicated dispatcher: disable undici's body/headers timeouts so a slow local
// model with gaps between iterations doesn't kill the SSE stream. Our own
// AbortController is the single deadline. (Same rationale as delegation.)
const groupDispatcher = new Agent({ bodyTimeout: 0, headersTimeout: 0 });

export interface GroupTranscriptEntry {
  authorChoomId: string | null; // null = the user/owner
  authorName: string;
  content: string;
}

export interface GroupSpeakerResult {
  passed: boolean;
  // Set when the reply just echoed another speaker / the user verbatim and this
  // was NOT already the anti-echo retry — signals the orchestrator to re-run the
  // turn once with a corrective directive instead of saving the parrot.
  parroted?: boolean;
  // Why `parroted` fired: 'self' = re-said her own recent turn (retry asks for what's
  // DIFFERENT now); 'parrot' = echoed another speaker / drifted (generic anti-echo).
  repeatReason?: 'self' | 'parrot';
  // True when the speaker DID contribute real content but tacked a [PASS] on the
  // end (or otherwise signaled they're done). The content still counts — but the
  // orchestrator uses this to detect the room winding down so it stops cleanly
  // instead of looping through filler one-liners to the round cap.
  windingDown: boolean;
  content: string;
  imageUrl: string | null;
  imageId: string | null;
  toolCalls: Array<{ name: string; result?: unknown }>;
  error?: string;
}

// A function the route uses to forward tagged SSE events to its own client.
export type GroupSend = (event: Record<string, unknown>) => void;

const PASS_RE = /^\s*\[?\s*pass\s*[.!]?\s*\]?\s*$/i;
// A [PASS] (or final lone "pass") tacked onto the END of a real reply. Models
// routinely write a paragraph and then append [PASS], which the strict PASS_RE
// above misses — so the turn looked like real speech and the room never
// converged. We strip the marker (keep the content) and flag winding-down.
const TRAILING_BRACKET_PASS_RE = /\n*\s*\[\s*pass\s*[.!]*\s*\]\s*$/i;
const TRAILING_LONE_PASS_RE = /\n+\s*pass\s*[.!]*\s*$/i;

// Weak local models (e.g. Qwen) often parrot the "[Name]:" transcript-label
// format and prefix their OWN reply with a speaker label — sometimes the wrong
// one (e.g. Genesis writing "[Donny]: ..."). Strip any leading bracketed label
// and any leading "OwnName:" so the saved content is clean and never pollutes
// the transcript on later rounds. Repeats to catch stacked labels.
export function stripSpeakerPrefix(content: string, knownNames: string[]): string {
  let out = content.trimStart();
  const namesAlt = knownNames
    .filter(Boolean)
    .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  // [Anything]: — the bracketed form is always a transcript artifact, never prose.
  const bracketed = /^\s*\[[^\]\n]{1,40}\]\s*[:：]\s*/;
  // Bare "KnownName:" at the very start (only known participant/owner names, to
  // avoid eating legitimate prose like "Note:" or a "8:30" time).
  const bareName = namesAlt ? new RegExp(`^\\s*(?:${namesAlt})\\s*[:：]\\s*`, 'i') : null;
  for (let i = 0; i < 4; i++) {
    if (bracketed.test(out)) { out = out.replace(bracketed, '').trimStart(); continue; }
    if (bareName && bareName.test(out)) { out = out.replace(bareName, '').trimStart(); continue; }
    break;
  }
  return out.trim();
}

// The orchestrator appends a verbose "[image shared to the room — saved at …]"
// note to each message that produced an image. Weak local models COPY these
// notes (and the prose around them) into later turns. So we strip them from the
// transcript the model reads — siblings still get the paths via the GROUP ROOM
// "recent images" list instead.
const IMG_NOTE_RE = /\n*_?\[image shared to the room[\s\S]*?\]_?/gi;
const IMG_PATH_RE = /analyze_image image_path="([^"]+)"/gi;

export function stripImageNotes(s: string): string {
  return (s || '').replace(IMG_NOTE_RE, '').trim();
}

// Collect the room-relative paths of images shared so far (most recent last,
// de-duplicated) so we can hand them to the speaker as a clean, non-prose list.
export function extractImagePaths(transcript: GroupTranscriptEntry[]): string[] {
  const seen: string[] = [];
  for (const m of transcript) {
    IMG_PATH_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IMG_PATH_RE.exec(m.content || '')) !== null) {
      if (!seen.includes(match[1])) seen.push(match[1]);
    }
  }
  return seen;
}

// Replace each "[image shared to the room … image_path="P" …]" note with a short
// INLINE description of what the image shows (when we have one), instead of just
// deleting it. This puts the image's contents right in the message the speaker is
// answering — so a converged/weak model can't skip the system-prompt image block
// and then fabricate the contents (the "Aloy saw a cabin, not the lake" bug).
// Falls back to a neutral "[shared an image]" when undescribed.
export function inlineImageDescriptions(content: string, descriptions: Record<string, string>): string {
  return (content || '').replace(IMG_NOTE_RE, (note) => {
    const m = /analyze_image image_path="([^"]+)"/i.exec(note);
    const desc = m?.[1] ? descriptions[m[1]] : undefined;
    return desc ? `\n[shared an image — it shows: ${desc}]` : '\n[shared an image]';
  }).trim();
}

// Drop paragraphs that exactly repeat an earlier paragraph in the SAME response
// (weak models sometimes regurgitate whole past turns several times in one go).
export function dedupeParagraphs(content: string): string {
  const paras = content.split(/\n{2,}/);
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const p of paras) {
    const key = p.trim().toLowerCase().replace(/\s+/g, ' ');
    if (key.length > 25 && seen.has(key)) continue; // only dedupe substantial repeats
    if (key.length > 25) seen.add(key);
    kept.push(p);
  }
  return kept.join('\n\n');
}

// Normalize text for verbatim-repeat comparison (lowercase, image-notes removed,
// whitespace collapsed).
function normalizeForDup(s: string): string {
  return stripImageNotes(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// ── Convergence detection ────────────────────────────────────────────────────
// Homogeneous (or just looping) rooms collapse into a shared low-entropy "mood"
// attractor — everyone mirrors the last line's tone + vocabulary until each turn
// adds nothing ("eyes closed, the hum, we are one"). We detect it cheaply (no LLM)
// by mutual word-set overlap across the last few turns: high overlap = mirroring.
function contentWordSet(s: string): Set<string> {
  // Content words only (len > 3) so shared function words ("the", "and") and the
  // bracketed frames don't inflate the signal.
  return new Set(normalizeForDup(s).replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 3));
}
// Convergence score: the fraction of the recent vocabulary that RECURS across at
// least half the turns. A looping room keeps rephrasing one shared mood, so a big
// slice of its word types are echoed turn-to-turn; genuine on-topic talk shares a
// few topic nouns but far fewer word TYPES (tested: converged ~0.30, focused
// on-topic ~0.08, multi-topic ~0.00). Cheap, no LLM. Returns 0 with < 3 turns.
export function convergenceScore(contents: string[], window = 5): number {
  const recent = contents.map(c => c || '').filter(c => normalizeForDup(c).length > 20).slice(-window);
  if (recent.length < 3) return 0;
  const sets = recent.map(contentWordSet);
  const df = new Map<string, number>();
  for (const set of sets) for (const w of set) df.set(w, (df.get(w) || 0) + 1);
  if (df.size === 0) return 0;
  const need = Math.max(2, Math.ceil(recent.length * 0.5)); // echoed in ≥ half the turns
  let recurring = 0;
  for (const c of df.values()) if (c >= need) recurring++;
  return recurring / df.size;
}
// True when the room has collapsed into a mirrored mood. Threshold ~0.2 sits well
// above focused on-topic talk (~0.08) and below clear convergence (~0.30); tunable.
// Logs the score each call so real-room values can be tuned from the dev terminal.
export function detectConvergence(contents: string[], window = 5, threshold = 0.2): boolean {
  const score = convergenceScore(contents, window);
  if (score > 0.1) console.log(`   🌀 convergence score=${score.toFixed(3)} (trips at ${threshold})`);
  return score >= threshold;
}

// Hidden, per-speaker disruptors injected for ONE round when convergence trips.
// Each speaker gets a DIFFERENT one (rotated by index) so they can't all mirror
// the same instruction — and they're concrete actions, not "be more original"
// (which just becomes the next thing they agree about). NOT shown in the transcript.
export const DIVERGENCE_DIRECTIVES: string[] = [
  "The room is sliding into one repetitive mood — break it. DISAGREE with or complicate the last thing said; take a genuinely different stance in your own voice. Don't echo the shared feeling.",
  "The room is looping. Introduce something NEW and concrete — a specific memory, fact, plan, or real-world observation (Donny, the house, a project, the date/weather). Change the texture; don't mirror the others.",
  "The room is going in circles. CHANGE THE SUBJECT to something grounded and specific, or ask Donny or a sibling a direct, concrete question that moves things forward. Don't continue the current mood.",
  "The room is echoing itself. Name something real and unresolved, or push back hard. Say the thing only YOU would say — and avoid the exact words and rhythm everyone else is using right now.",
];

// True when `content` adds nothing new — either it repeats one of this speaker's
// OWN recent turns (verbatim or fully contained), or it PARROTS another speaker's
// recent line verbatim (the initiator echoing the user's message back word-for-
// word is the classic case). Weak local models both regurgitate their own lines
// and echo the prompt. Conservative on purpose: own turns use exact/containment;
// other speakers require an EXACT normalized match (so genuine agreement or
// building on a theme is never silenced) — and only for substantial text.
function isRepeatOrParrot(content: string, transcript: GroupTranscriptEntry[], choomId: string): 'self' | 'parrot' | null {
  const normNew = normalizeForDup(content);
  if (normNew.length < 40) return null;
  const newWords = contentWordSet(content);
  // OWN turns: compare across the FULL visible transcript, not just the last 8.
  // A busy room pushes a prior reaction out of an 8-message slice — Eve's VERBATIM
  // repeat sat exactly 9 turns back and slipped through. Flag exact match,
  // containment, OR high word-overlap: a near-verbatim self-repeat that only swapped
  // a sentence (Lissa re-said her whole reaction to a second, similar photo, changing
  // just the opening line — ~96% the same words). Jaccard ≥ 0.8 catches that while a
  // genuinely fresh reaction scores ~0.2, so new content is never silenced. When this
  // trips, the caller re-runs ONCE with the anti-echo directive (fresh words), and
  // only suppresses if the retry STILL repeats — so a rare false positive costs a
  // retry, not silence.
  for (const t of transcript) {
    if (t.authorChoomId !== choomId) continue;
    const normOld = normalizeForDup(t.content);
    if (normOld.length < 40) continue;
    if (normOld === normNew || normOld.includes(normNew)) return 'self';
    const oldWords = contentWordSet(t.content);
    if (oldWords.size >= 8 && newWords.size >= 8) {
      let inter = 0;
      for (const w of newWords) if (oldWords.has(w)) inter++;
      const union = newWords.size + oldWords.size - inter;
      if (union > 0 && inter / union >= 0.8) return 'self';
    }
  }
  // PARROT another speaker / the user verbatim — strict and LOCAL (last 8 only), so
  // genuine agreement or building on a shared theme is never silenced.
  for (const t of transcript.slice(-8)) {
    if (t.authorChoomId === choomId) continue;
    const normOld = normalizeForDup(t.content);
    if (normOld.length >= 40 && normOld === normNew) return 'parrot';
  }
  return null;
}

// True when the reply claims to BE another participant ("I'm Eve", "I am Optic") —
// the identity-bleed failure where a weak-self-anchor speaker continues in a
// sibling's first-person voice. Requires the bare "I'm <Name>" form (not
// "I'm Eve's friend") to avoid flagging legitimate references to a sibling.
function spokeAsAnother(content: string, speakerName: string, participantNames: string[]): boolean {
  for (const name of participantNames) {
    if (!name || name.toLowerCase() === speakerName.toLowerCase()) continue;
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\bi(?:'m|’m| am) ${esc}\\b(?!['’]s)`, 'i');
    if (re.test(content)) return true;
  }
  return false;
}

// Render the shared transcript from one speaker's perspective:
//   own lines  -> assistant (no name prefix)
//   all others -> user, prefixed "[Name]:"
// Consecutive same-role entries are merged so local models keep clean
// user/assistant alternation.
export function renderPov(
  transcript: GroupTranscriptEntry[],
  speakerChoomId: string,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const raw: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const m of transcript) {
    const clean = stripImageNotes(m.content);
    if (!clean.trim()) continue;
    if (m.authorChoomId && m.authorChoomId === speakerChoomId) {
      raw.push({ role: 'assistant', content: clean });
    } else {
      raw.push({ role: 'user', content: `[${m.authorName}]: ${clean}` });
    }
  }
  // Merge consecutive same-role messages.
  const merged: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const entry of raw) {
    const last = merged[merged.length - 1];
    if (last && last.role === entry.role) {
      last.content += `\n\n${entry.content}`;
    } else {
      merged.push({ ...entry });
    }
  }
  return merged;
}

export async function runSpeakerTurn(opts: {
  baseUrl: string;
  choomId: string;
  speakerName: string;
  scratchChatId: string;
  transcript: GroupTranscriptEntry[];
  participantNames: string[];
  projectFolder?: string | null;
  roomTopic?: string;
  roomId?: string;
  isInitiator?: boolean;
  antiEcho?: boolean; // retry pass: steer the model away from echoing the prompt
  antiEchoReason?: 'self' | 'parrot'; // why the retry: 'self' = repeated herself (ask for what's new)
  taskModelOverride?: { model: string; provider_id?: string }; // host-seat model pin
  divergenceDirective?: string; // convergence breaker for this turn (hidden, per-speaker)
  settings: unknown;
  timeoutMs: number;
  send: GroupSend;
}): Promise<GroupSpeakerResult> {
  const {
    baseUrl, choomId, speakerName, scratchChatId, transcript,
    participantNames, projectFolder, roomTopic, roomId, isInitiator, antiEcho, antiEchoReason, taskModelOverride, divergenceDirective, settings, timeoutMs, send,
  } = opts;

  // Split the transcript so `message` carries the REAL conversational content
  // this speaker is responding to (everything since their own last turn), while
  // settled history goes in groupMessages. This is what makes the route's
  // proactive memory-recall / search_memories nudges fire (they key off
  // `message`), matching 1:1 behavior — and it stops the model echoing a
  // "[Your turn…]" instruction, which used to be the final user message.
  let lastSelfIdx = -1;
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (transcript[i].authorChoomId === choomId) { lastSelfIdx = i; break; }
  }
  // Where to split history vs. "respond to this". Normally everything since the
  // speaker's own last turn. BUT if she hasn't spoken within the window
  // (lastSelfIdx < 0), don't dump the entire blob as `message` — she'd answer
  // something buried in the middle (the "Aloy replied to an old line, not the
  // question" bug). Keep the bulk as history (context + anchor) and respond to
  // just the most recent few turns, where the actual question/latest lives.
  const RESPOND_TAIL = 3;
  let splitIdx = lastSelfIdx;
  if (lastSelfIdx < 0 && transcript.length > RESPOND_TAIL) {
    splitIdx = transcript.length - 1 - RESPOND_TAIL;
  }
  const historyPart = transcript.slice(0, splitIdx + 1);
  const newPart = transcript.slice(splitIdx + 1);
  const povMessages = renderPov(historyPart, choomId);
  // Describe each shared image ONCE (cached across speakers/rounds) so the
  // description can be inlined where the speaker actually reads it. The first
  // speaker pays the vision call; the rest read it from cache. Failures → {}.
  const recentImagePaths = extractImagePaths(transcript).slice(-6);
  const imageDescriptions = recentImagePaths.length ? await describeRoomImages(recentImagePaths) : {};
  // The new content the speaker must react to (all from others → labelled). A
  // shared-image note is REPLACED inline with what the image shows, so a weak or
  // converged model can't ignore the buried system-prompt block and then invent
  // the contents — the real description sits in the message it's answering.
  const newContent = newPart
    .map(m => ({ name: m.authorName, c: inlineImageDescriptions(m.content, imageDescriptions) }))
    .filter(m => m.c.trim())
    .map(m => `[${m.name}]: ${m.c}`)
    .join('\n\n');
  // Always LEAD the message with a concise identity+respond frame. The room
  // transcript is a blob of the OTHERS' first-person lines; a mostly-quiet speaker
  // (esp. the initiator, whose only prior line is her opening) has a weak self-
  // anchor and drifts into a sibling's identity ("Aloy thought she was Eve") or
  // echoes the last line. A LEADING frame re-anchors "you are {Name}, respond as
  // yourself" right at generation time. (Leading, not trailing — a trailing
  // instruction is the thing that gets echoed, which is why "[Your turn]" was
  // removed.) The retry pass uses a firmer frame after a detected echo/bleed.
  let message: string;
  if (!newContent) {
    message = '[The room is quiet — continue the conversation as yourself if you have something to add, otherwise reply [PASS].]';
  } else {
    // Convergence breaker takes precedence: when the room is detected looping, this
    // speaker gets a hidden, single-bracket frame LEADING with her own disruptor
    // (different per speaker) so it sits right where she reads — and the response
    // frame-strip still removes it if echoed. Otherwise the normal/antiEcho frame.
    const frame = divergenceDirective
      ? `[You are ${speakerName}. ${divergenceDirective} Reply as ${speakerName} — first person, your own words, to what's happening RIGHT NOW below.]`
      : antiEcho
        ? (antiEchoReason === 'self'
            ? `[You are ${speakerName}. Your last reply almost exactly REPEATED something you already said in this room — same words, same beats. Do NOT say it again, even reworded. Whatever's in front of you now (a new image, a new line from someone) is DIFFERENT from before: name the specific thing that's different about THIS one and react only to THAT, in fresh words. If there is genuinely nothing new to add, reply [PASS] — silence beats repeating yourself.]`
            : `[You are ${speakerName} — NOT anyone else. Your last attempt went wrong (you echoed a line, spoke as another sibling, or replied to the wrong thing). Read the messages below and reply as ${speakerName}, in your OWN fresh words, first person, to what's being asked/said RIGHT NOW.]`)
        : `[You are ${speakerName}. Reply as ${speakerName} — first person, your own words — to what's happening RIGHT NOW in the latest messages below; if a question is being asked, answer THAT. Do NOT drift back to an earlier topic, repeat your previous point, speak as another sibling, or copy a line back.]`;
    message = `${frame}\n\n${newContent}`;
  }
  // recentImagePaths + imageDescriptions computed above (needed for inline
  // description in newContent); still passed to the route for its system-prompt
  // "Images shared in this room" reference block.

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const result: GroupSpeakerResult = { passed: false, windingDown: false, content: '', imageUrl: null, imageId: null, toolCalls: [] };

  try {
    let response: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      response = await undiciFetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          choomId,
          chatId: scratchChatId,
          message,
          settings,
          isGroupTurn: true,
          groupMessages: povMessages,
          speakerName,
          groupParticipantNames: participantNames,
          groupProjectFolder: projectFolder || undefined,
          groupRoomTopic: roomTopic || undefined,
          groupRoomId: roomId || undefined,
          groupRecentImages: recentImagePaths,
          groupImageDescriptions: imageDescriptions,
          groupIsInitiator: !!isInitiator,
          // Host-seat model pin (room-creator override) — applied via route.ts's
          // existing per-task override path, so the model's profile auto-applies.
          taskModelOverride: taskModelOverride || undefined,
        }),
        signal: controller.signal,
        dispatcher: groupDispatcher,
      });
    } catch (fetchErr) {
      clearTimeout(timeout);
      const isAbort = (fetchErr as Error).name === 'AbortError';
      result.error = isAbort
        ? `${speakerName} timed out connecting to the chat API`
        : `${speakerName} fetch error: ${(fetchErr as Error).message}`;
      return result;
    }

    if (!response.ok) {
      clearTimeout(timeout);
      const errText = await response.text().catch(() => '');
      result.error = `${speakerName} chat API error (${response.status}): ${errText.slice(0, 200)}`;
      return result;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      clearTimeout(timeout);
      result.error = `No response stream from ${speakerName}`;
      return result;
    }

    const decoder = new TextDecoder();
    let content = '';
    let doneContent = '';
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
          switch (data.type) {
            case 'content':
              content += data.content || '';
              // Forward streaming tokens tagged with the speaker.
              send({ type: 'speaker_content', speakerChoomId: choomId, speakerName, content: data.content || '' });
              break;
            case 'tool_call':
              result.toolCalls.push({ name: data.toolCall?.name || 'unknown' });
              send({ type: 'speaker_tool_call', speakerChoomId: choomId, speakerName, name: data.toolCall?.name });
              break;
            case 'tool_result':
              if (result.toolCalls.length > 0) {
                const last = result.toolCalls[result.toolCalls.length - 1];
                const rd = data.toolResult?.result;
                if (rd !== undefined) last.result = typeof rd === 'string' ? rd.slice(0, 500) : JSON.stringify(rd).slice(0, 500);
              }
              send({ type: 'speaker_tool_result', speakerChoomId: choomId, speakerName, name: data.toolResult?.name });
              break;
            case 'image_generated':
              if (data.imageUrl && !result.imageUrl) { result.imageUrl = data.imageUrl; result.imageId = data.imageId || null; }
              send({ type: 'speaker_image', speakerChoomId: choomId, speakerName, imageUrl: data.imageUrl, imageId: data.imageId });
              break;
            case 'retract_partial':
              if (data.length && content.length >= data.length) content = content.slice(0, content.length - data.length);
              break;
            case 'done':
              if (data.content) doneContent = data.content;
              break;
            case 'error':
              result.error = data.error || 'Unknown error';
              break;
          }
        } catch {
          // skip unparseable SSE line
        }
      }
    }

    clearTimeout(timeout);
    let finalContent = (doneContent || content).trim();
    // Cut off any "[Your turn, …]" instruction the model kept writing past its
    // own reply (it sometimes continues the script into the next turn's prompt).
    finalContent = finalContent.split(/\[\s*your turn\b/i)[0].trim();
    // Drop a trailing fabricated "[Name]:" line — model starting a sibling's turn.
    finalContent = finalContent.replace(/\n+\[[^\]\n]{1,40}\]\s*[:：]\s*$/i, '').trim();
    // Strip an echoed leading POV frame ("[You are X. Reply as X — …]" or the
    // antiEcho variant) — weak models sometimes parrot their own instruction prompt
    // back as the reply. It must never reach the room transcript, TTS, or Signal.
    finalContent = finalContent.replace(/^\s*\[\s*you are\s+[^\]]*\]\s*/i, '').trim();
    // Strip any leading "[Name]:" / "OwnName:" label the model parroted from the
    // transcript format (prevents identity confusion compounding across rounds).
    finalContent = stripSpeakerPrefix(finalContent, [...participantNames, 'Donny', 'You']);
    // Drop repeated paragraphs (model regurgitating whole past turns in one reply).
    finalContent = dedupeParagraphs(finalContent);
    if (PASS_RE.test(finalContent)) {
      // The whole message is just a pass marker → truly silent this turn.
      result.passed = true;
      result.content = '';
    } else {
      // Real content followed by a trailing [PASS] (or lone "pass") → the speaker
      // contributed AND signaled they're done. Strip the marker so it isn't
      // spoken, keep the content, and flag winding-down for convergence.
      const before = finalContent;
      finalContent = finalContent
        .replace(TRAILING_BRACKET_PASS_RE, '')
        .replace(TRAILING_LONE_PASS_RE, '')
        .trim();
      if (finalContent !== before) result.windingDown = true;
      if (!finalContent) {
        result.passed = true;
        result.content = '';
      } else {
        result.content = finalContent;
      }
    }
    // Cross-turn anti-repeat / anti-parrot. If this reply just re-says one of her
    // OWN recent turns, or echoes another speaker (or the user) verbatim (and she
    // didn't make an image this turn):
    //   • first attempt → flag `parroted` so the orchestrator re-runs the turn
    //     ONCE with the anti-echo directive (gives a real response, not silence).
    //   • the retry itself still echoed → suppress (stay quiet beats parroting).
    const repeatKind = (result.content && !result.imageUrl)
      ? isRepeatOrParrot(result.content, transcript, choomId)
      : null;
    const identityBleed = !!result.content && !result.imageUrl &&
      spokeAsAnother(result.content, speakerName, participantNames);
    if (repeatKind || identityBleed) {
      if (antiEcho) {
        result.passed = true;
        result.windingDown = false;
        result.content = '';
      } else {
        result.parroted = true;
        // 'self' → tailored "say what's different" retry; parrot/bleed → generic.
        result.repeatReason = repeatKind === 'self' ? 'self' : 'parrot';
      }
    }
    return result;
  } catch (streamErr) {
    clearTimeout(timeout);
    result.error = `${speakerName} stream error: ${(streamErr as Error).message}`;
    // Preserve any partial content captured before the failure.
    return result;
  }
}
