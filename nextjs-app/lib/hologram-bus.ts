/**
 * Live feed of what each Choom is doing, for the Looking Glass hologram on the NUC.
 *
 * runChatTurn() mirrors every chat turn here (web, Signal, rooms, heartbeats, delegation) and
 * GET /api/hologram/events streams it. The hologram shows whoever is talking and speaks her
 * reply in her own voice. With no subscriber connected, publishing is a no-op.
 *
 * Events: turn_start, thinking, tool, image, content (speakable text), retract, done, error,
 * turn_end. Each carries { choom, choomId, chatId, voice, source }. A tool event names the sister
 * when Aloy delegates (target); an image event carries the gallery imageId and its kind: selfie,
 * picture, snapshot (a camera) or looking (an image she is analyzing), so the hologram can float it
 * beside her.
 *
 * Voice hand-off: while the hologram posts heartbeats saying it is speaking, browsers on the home
 * network stay quiet (lib/hologram-voice.ts), so a reply is never spoken twice and Chatterbox
 * never renders it twice.
 *
 * Like the web app, the hologram speaks a conversation only while a browser at home has that
 * chat or room open: each content event carries `speak`, decided when it is sent. Rooms the
 * Chooms run on their own, Signal chats and heartbeats are shown but stay silent.
 */
import { isSentenceEnd, stripForTTS } from '@/lib/utils';

export interface HologramTurn {
  choom: string;
  choomId: string;
  chatId: string;
  voice: string | null;
  source: 'chat' | 'group' | 'heartbeat' | 'delegation';
  roomId: string | null;
}

type HologramEvent = Record<string, unknown>;
type Listener = (event: HologramEvent) => void;

// Kept on globalThis so dev-server hot reloads don't orphan connected subscribers.
const store = globalThis as unknown as {
  __choomHologramListeners?: Set<Listener>;
  __choomHologramVoice?: { voice: boolean; at: number };
  __choomHologramViewing?: Map<string, number>;
};
const listeners = (store.__choomHologramListeners ??= new Set<Listener>());

export function subscribeHologram(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether a hologram is following the feed (the glass is running). */
export function hologramConnected(): boolean {
  return listeners.size > 0;
}

export function publishHologram(event: HologramEvent): void {
  if (listeners.size === 0) return;
  const stamped = { ...event, time: Date.now() };
  for (const listener of listeners) {
    try {
      listener(stamped);
    } catch {
      // A broken subscriber must never affect the chat turn.
    }
  }
}

// ---- Voice hand-off ------------------------------------------------------------------------
const VOICE_FRESH_MS = 25_000; // the hologram posts every 10 s; two misses and the browsers speak again

export function setHologramVoice(voice: boolean): void {
  store.__choomHologramVoice = { voice, at: Date.now() };
}

export function hologramVoiceActive(): boolean {
  const v = store.__choomHologramVoice;
  return !!v && v.voice && Date.now() - v.at < VOICE_FRESH_MS;
}

/** The web app's mute button, passed on: the hologram stops talking and stays quiet until unmuted. */
export function setHologramMuted(muted: boolean): void {
  publishHologram({ type: 'mute', muted });
  // Update the hand-off now rather than at the hologram's next heartbeat, so browsers polling
  // right after an unmute already know the hologram has the voice back (if it's running).
  const v = store.__choomHologramVoice;
  if (v && Date.now() - v.at < VOICE_FRESH_MS) setHologramVoice(!muted);
}

// ---- Donny talking to them -----------------------------------------------------------------
/**
 * Donny typing to a Choom or talking into the mic (from the chat input at home): the hologram
 * shows her listening until it hears that he stopped, or until her turn starts.
 */
export function setHologramListening(e: {
  listening: boolean;
  source: 'mic' | 'typing';
  choom: string | null;
  chatId: string | null;
  roomId: string | null;
}): void {
  publishHologram({ type: 'listening', ...e });
}

const PRIVATE_IP = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fe80:|fc|fd)/i;

/**
 * True when a request came from away from home: through ngrok, or from a public address. Nobody
 * is in front of the hologram then, so it neither takes that browser's voice nor reacts to it.
 */
export function requestFromAway(request: Request): boolean {
  const host = request.headers.get('host') ?? '';
  if (/ngrok/i.test(host)) return true;
  const forwarded = (request.headers.get('x-forwarded-for') ?? '').split(',')[0].trim();
  return forwarded !== '' && !PRIVATE_IP.test(forwarded.replace(/^::ffff:/, ''));
}

// ---- What browsers at home have open -------------------------------------------------------
const viewing = (store.__choomHologramViewing ??= new Map<string, number>());

/** A browser at home has this chat or room open (reported with each hand-off poll, every 10 s). */
export function markViewing(kind: 'chat' | 'room', id: string): void {
  viewing.set(`${kind}:${id}`, Date.now());
}

function isViewing(kind: 'chat' | 'room', id: string | null): boolean {
  const at = id ? viewing.get(`${kind}:${id}`) : undefined;
  return at !== undefined && Date.now() - at < VOICE_FRESH_MS;
}

function shouldSpeak(turn: HologramTurn): boolean {
  if (turn.source === 'chat') return isViewing('chat', turn.chatId);
  if (turn.source === 'group') return isViewing('room', turn.roomId);
  return false; // heartbeats and delegation are shown, never spoken
}

// ---- Turn mirroring ------------------------------------------------------------------------
/**
 * Gathers streamed reply text into speakable pieces exactly as the web client's StreamingTTS
 * does: think blocks and fenced code are skipped, a piece goes out at each sentence end, and a
 * large delivered chunk is split into ~350-character groups of whole sentences.
 */
class SpeechSegmenter {
  private buffer = '';
  private fullText = '';
  private insideThinking = false;
  private insideCodeBlock = false;

  constructor(private readonly emit: (text: string) => void) {}

  onToken(token: string): void {
    this.buffer += token;
    this.fullText += token;

    if (/<think>/i.test(this.buffer) || /\[think\]/i.test(this.buffer)) {
      this.insideThinking = true;
      this.buffer = this.buffer.replace(/<think>[\s\S]*/i, '').replace(/\[think\][\s\S]*/i, '');
    }
    if (this.insideThinking) {
      if (/<\/think>/i.test(this.buffer) || /\[\/think\]/i.test(this.buffer)) {
        this.insideThinking = false;
        this.buffer = this.buffer.replace(/[\s\S]*<\/think>/i, '').replace(/[\s\S]*\[\/think\]/i, '');
      } else {
        this.buffer = '';
        return;
      }
    }

    // Fence-count parity over everything so far: odd = inside a code block.
    const wasInsideCodeBlock = this.insideCodeBlock;
    this.insideCodeBlock = (this.fullText.match(/```/g) || []).length % 2 === 1;
    if (this.insideCodeBlock) {
      this.buffer = '';
      return;
    }
    if (wasInsideCodeBlock) {
      // Keep only what follows the closing fence. A fence split across tokens leaves stray
      // backticks at the start of the buffer; drop those too.
      const parts = this.buffer.split('```');
      this.buffer = parts[parts.length - 1].replace(/^`+/, '');
      if (!this.buffer.trim()) {
        this.buffer = '';
        return;
      }
    }

    if (isSentenceEnd(this.buffer)) {
      this.say(this.buffer);
      this.buffer = '';
    } else if (this.buffer.length > 600 && !this.buffer.includes('```')) {
      const pieces = this.buffer.match(/[\s\S]*?[.!?…](?:["')\]]*)(?:\s+|$)/g) || [];
      if (pieces.length > 0) {
        let group = '';
        for (const piece of pieces) {
          group += piece;
          if (group.length >= 350) {
            this.say(group);
            group = '';
          }
        }
        if (group.trim()) this.say(group);
        this.buffer = this.buffer.slice(pieces.join('').length);
      }
    }
  }

  flush(): void {
    if (this.buffer.trim()) this.say(this.buffer);
    this.buffer = '';
  }

  reset(): void {
    this.buffer = '';
    this.fullText = '';
    this.insideThinking = false;
    this.insideCodeBlock = false;
  }

  private say(raw: string): void {
    const text = stripForTTS(raw.trim());
    if (text) this.emit(text);
  }
}

/**
 * Start mirroring one chat turn. Feed it every SSE event the turn sends (event), and call end()
 * when the turn finishes. Cheap when nobody is subscribed. `prompt` is what Donny (or the room)
 * just said: the hologram reads its feeling so she can react before she answers. Only the start
 * event carries it, trimmed.
 */
export function startHologramTurn(
  turn: HologramTurn,
  prompt?: string,
): { event: (data: Record<string, unknown>) => void; end: () => void } {
  const speech = new SpeechSegmenter((text) =>
    publishHologram({ type: 'content', ...turn, text, speak: shouldSpeak(turn) }));
  const said = (turn.source === 'chat' || turn.source === 'group') && prompt ? prompt.slice(0, 500) : undefined;
  publishHologram({ type: 'turn_start', ...turn, ...(said ? { prompt: said } : {}) });
  // Which tool made the next image: a self-portrait, a camera snapshot, or any other picture.
  let lastTool: string | null = null;
  let selfPortrait = false;
  return {
    event(data) {
      if (listeners.size === 0) return;
      switch (data.type) {
        case 'content':
          if (typeof data.content === 'string') speech.onToken(data.content);
          break;
        case 'retract_partial':
          speech.reset();
          publishHologram({ type: 'retract', ...turn });
          break;
        case 'thinking':
          publishHologram({ type: 'thinking', ...turn });
          break;
        case 'tool_call': {
          const call = data.toolCall as { name?: unknown; arguments?: unknown } | undefined;
          const name = typeof call?.name === 'string' ? call.name : null;
          const args = (call?.arguments && typeof call.arguments === 'object' ? call.arguments : {}) as Record<string, unknown>;
          lastTool = name;
          if (name === 'generate_image') selfPortrait = args.self_portrait === true;
          const target = name === 'delegate_to_choom' && typeof args.choom_name === 'string' ? args.choom_name : null;
          publishHologram({ type: 'tool', ...turn, tool: name, ...(target ? { target } : {}) });
          if (name === 'analyze_image' && typeof args.image_id === 'string') {
            publishHologram({ type: 'image', ...turn, imageId: args.image_id, kind: 'looking' });
          }
          break;
        }
        case 'tool_result': {
          // A tool that failed (an error, or success: false): she makes a face at her own mishap.
          const r = data.toolResult as { name?: unknown; error?: unknown; result?: unknown } | undefined;
          const body = r?.result && typeof r.result === 'object' ? r.result as Record<string, unknown> : null;
          if (r && (r.error || body?.success === false)) {
            publishHologram({ type: 'tool_failed', ...turn, tool: typeof r.name === 'string' ? r.name : null });
          }
          break;
        }
        case 'image_generated':
          if (typeof data.imageId === 'string') {
            const kind = lastTool === 'ha_get_camera_snapshot' ? 'snapshot' : selfPortrait ? 'selfie' : 'picture';
            publishHologram({ type: 'image', ...turn, imageId: data.imageId, kind });
          }
          selfPortrait = false;
          break;
        case 'done':
          speech.flush();
          publishHologram({ type: 'done', ...turn });
          break;
        case 'error':
          publishHologram({ type: 'error', ...turn });
          break;
      }
    },
    end() {
      publishHologram({ type: 'turn_end', ...turn });
    },
  };
}
