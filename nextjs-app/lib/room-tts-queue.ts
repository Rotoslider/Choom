import type { TTSSettings } from './types';
import { stripForTTS } from './utils';

// Sequential, per-speaker TTS queue for group rooms.
//
// Each enqueued clip is synthesized with its speaker's own voiceId and played
// to completion (await `ended`) before the next clip starts — so two Chooms'
// voices can NEVER overlap and each renders fully before the next speaks.
// This is intentionally simpler than StreamingTTS: group turns deliver whole
// messages (not token streams), and strict serialization is the whole point.
export class RoomTTSQueue {
  private endpoint: string;
  private speed: number;
  private muted = false;
  private queue: Array<{ text: string; voiceId: string }> = [];
  private playing = false;
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

  // Add a speaker's message to the playback queue.
  enqueue(text: string, voiceId: string | null) {
    if (this.muted) return;
    const clean = stripForTTS(text || '');
    if (!clean.trim()) return;
    this.queue.push({ text: clean, voiceId: voiceId || 'sophie' });
    if (!this.playing) void this.playNext();
  }

  stop() {
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio.src = '';
      this.currentAudio = null;
    }
    this.queue = [];
    this.playing = false;
    this.onSpeakingChange?.(false, null);
  }

  private async playNext() {
    if (this.muted || this.queue.length === 0) {
      this.playing = false;
      this.onSpeakingChange?.(false, null);
      return;
    }
    this.playing = true;
    const { text, voiceId } = this.queue.shift()!;
    this.onSpeakingChange?.(true, voiceId);

    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: voiceId, endpoint: this.endpoint, speed: this.speed }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.success && data.audio && !this.muted) {
          const audio = new Audio(`data:audio/wav;base64,${data.audio}`);
          this.currentAudio = audio;
          await new Promise<void>((resolve) => {
            audio.onended = () => resolve();
            audio.onerror = () => resolve();
            audio.play().catch(() => resolve());
          });
          this.currentAudio = null;
        }
      }
    } catch {
      // Synthesis failed — skip this clip, keep the queue moving.
    }

    // Small gap to avoid clipping, then play the next speaker.
    await new Promise((r) => setTimeout(r, 30));
    void this.playNext();
  }
}
