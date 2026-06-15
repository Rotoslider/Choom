import type { TTSSettings } from './types';
import { stripForTTS } from './utils';
import { withAudioLock } from './audio-lock';

// Split a block of text into sentence-sized chunks for snappy, incremental TTS.
// Splits after sentence-ending punctuation followed by whitespace; very short
// trailing fragments are merged into the previous chunk so we don't synth a lone
// "Yeah." as its own request. Falls back to the whole text if no boundaries.
function splitSentences(text: string): string[] {
  const parts = text.split(/(?<=[.!?…])\s+/).map(s => s.trim()).filter(Boolean);
  if (parts.length <= 1) return parts.length ? parts : [text];
  const merged: string[] = [];
  for (const p of parts) {
    if (merged.length && p.length < 12) merged[merged.length - 1] += ' ' + p;
    else merged.push(p);
  }
  return merged;
}

// Pipelined, per-speaker TTS queue for group rooms.
//
// Two independent loops run concurrently:
//   • synth loop  — fetches /api/tts for upcoming sentences, up to MAX_AHEAD
//                   clips ahead of playback, and parks ready <audio> elements.
//   • play  loop  — plays ready clips back-to-back (holding the global audio
//                   lock so room and 1:1 never overlap).
// Because the NEXT sentence is already synthesized while the current one plays,
// there's no synth gap between sentences — this is what makes room audio feel as
// fast as 1:1 instead of "pull-your-hair-out slow waiting for the next sentence."
// Strict in-order playback is preserved (one clip at a time), so voices never
// overlap.
export class RoomTTSQueue {
  private static readonly MAX_AHEAD = 3; // pre-synthesize up to this many clips

  private endpoint: string;
  private speed: number;
  private muted = false;
  private pending: Array<{ text: string; voiceId: string }> = []; // awaiting synth
  private ready: Array<{ audio: HTMLAudioElement; voiceId: string }> = []; // synthesized
  private synthing = false;
  private playing = false;
  private epoch = 0; // bumped on stop(); loops from a prior epoch exit cleanly
  private currentAudio: HTMLAudioElement | null = null;
  private onSpeakingChange?: (speaking: boolean, voiceId: string | null) => void;

  constructor(settings: TTSSettings, onSpeakingChange?: (speaking: boolean, voiceId: string | null) => void) {
    this.endpoint = settings.endpoint;
    this.speed = settings.speed;
    this.onSpeakingChange = onSpeakingChange;
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (muted) this.stop();
  }

  // Queue a speaker's message. Split into sentences so the first one starts
  // synthesizing immediately; the synth loop then races ahead of playback.
  enqueue(text: string, voiceId: string | null) {
    if (this.muted) return;
    const clean = stripForTTS(text || '');
    if (!clean.trim()) return;
    const voice = voiceId || 'sophie';
    for (const sentence of splitSentences(clean)) {
      this.pending.push({ text: sentence, voiceId: voice });
    }
    void this.pumpSynth();
    void this.pumpPlay();
  }

  stop() {
    this.epoch++; // invalidate any in-flight synth/play loops
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio.src = '';
      this.currentAudio = null;
    }
    this.pending = [];
    this.ready = [];
    this.playing = false;
    this.synthing = false;
    this.onSpeakingChange?.(false, null);
  }

  private async synthOne(text: string, voiceId: string): Promise<HTMLAudioElement | null> {
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: voiceId, endpoint: this.endpoint, speed: this.speed }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data.success || !data.audio) return null;
      const audio = new Audio(`data:audio/wav;base64,${data.audio}`);
      audio.load();
      return audio;
    } catch {
      return null;
    }
  }

  // Synthesize ahead of playback, capped at MAX_AHEAD ready clips.
  private async pumpSynth() {
    if (this.synthing) return;
    this.synthing = true;
    const myEpoch = this.epoch;
    try {
      while (myEpoch === this.epoch && !this.muted && this.pending.length > 0 && this.ready.length < RoomTTSQueue.MAX_AHEAD) {
        const next = this.pending.shift()!;
        const audio = await this.synthOne(next.text, next.voiceId);
        if (myEpoch !== this.epoch || this.muted) break; // stopped while synthesizing
        if (audio) {
          this.ready.push({ audio, voiceId: next.voiceId });
          void this.pumpPlay(); // a clip is ready — make sure playback is running
        }
      }
    } finally {
      if (myEpoch === this.epoch) this.synthing = false;
    }
  }

  // Play ready clips one at a time, in order.
  private async pumpPlay() {
    if (this.playing) return;
    this.playing = true;
    const myEpoch = this.epoch;
    try {
      while (myEpoch === this.epoch && !this.muted) {
        if (this.ready.length === 0) {
          // Nothing ready: if more is coming (queued or mid-synth), wait briefly;
          // otherwise we're done.
          if (this.pending.length === 0 && !this.synthing) break;
          await new Promise((r) => setTimeout(r, 40));
          void this.pumpSynth();
          continue;
        }
        const { audio, voiceId } = this.ready.shift()!;
        void this.pumpSynth(); // freed a buffer slot → synth further ahead
        this.onSpeakingChange?.(true, voiceId);
        this.currentAudio = audio;
        // Hold the global audio lock only while actually playing, so a 1:1 reply
        // can't overlap the room (and vice versa). Synthesis above runs lock-free.
        await withAudioLock(() => new Promise<void>((resolve) => {
          if (myEpoch !== this.epoch || this.muted) { resolve(); return; }
          audio.onended = () => resolve();
          audio.onerror = () => resolve();
          audio.play().catch(() => resolve());
        }));
        if (myEpoch !== this.epoch) break; // stopped mid-clip
        this.currentAudio = null;
        await new Promise((r) => setTimeout(r, 20)); // tiny gap to avoid clipping
      }
    } finally {
      if (myEpoch === this.epoch) {
        this.playing = false;
        if (this.ready.length === 0 && this.pending.length === 0) {
          this.onSpeakingChange?.(false, null);
        }
      }
    }
  }
}
