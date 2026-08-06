import type { TTSSettings } from './types';
import { isSentenceEnd, stripForTTS } from './utils';
import { log } from './log-store';
import { withAudioLock } from './audio-lock';
import { registerAudioPlayer } from './audio-registry';

interface QueueEntry {
  audio: HTMLAudioElement;
}

export class StreamingTTS {
  private endpoint: string;
  private voiceId: string;
  private speed: number;
  private buffer: string = '';
  private audioQueue: QueueEntry[] = [];
  // Bumped by reset()/stop(); closures capture it so stale queued work self-cancels.
  private generation: number = 0;
  private isPlaying: boolean = false;
  private onSpeakingChange?: (isSpeaking: boolean) => void;
  private onAudioReady?: (audioBase64: string, audioElement: HTMLAudioElement) => boolean;
  private isMuted: boolean = false;
  private currentAudio: HTMLAudioElement | null = null;
  private insideThinking: boolean = false; // Track if we're inside thinking tags
  private insideCodeBlock: boolean = false; // Track if we're inside ``` fenced code blocks
  private fullText: string = ''; // Accumulates ALL tokens for reliable fence tracking
  private ttsQueue: Promise<void> = Promise.resolve(); // Serialize TTS requests
  // stop() is NOT final: a still-running stream reader that calls onToken()
  // afterward captures the post-bump generation and happily resumes speaking
  // (that's how the orphaned-instance incident kept talking after unmount).
  // dispose() is final — the instance goes permanently inert.
  private disposed: boolean = false;
  private unregister: () => void;

  constructor(
    settings: TTSSettings,
    onSpeakingChange?: (isSpeaking: boolean) => void,
    onAudioReady?: (audioBase64: string, audioElement: HTMLAudioElement) => boolean,
  ) {
    this.endpoint = settings.endpoint;
    this.voiceId = settings.defaultVoice;
    this.speed = settings.speed;
    this.onSpeakingChange = onSpeakingChange;
    this.onAudioReady = onAudioReady;
    this.unregister = registerAudioPlayer(this);
  }

  setMuted(muted: boolean) {
    this.isMuted = muted;
    if (muted) {
      this.stop();
    }
  }

  // Permanently kill this instance: stop audio, drop the queue, and make
  // every future onToken()/flush() a no-op. Call on component unmount so a
  // detached stream reader can't keep feeding an orphan.
  dispose() {
    this.disposed = true;
    this.stop();
    this.unregister();
  }

  setVoice(voiceId: string) {
    this.voiceId = voiceId;
  }

  // Called for each token from the LLM stream
  onToken(token: string) {
    if (this.disposed || this.isMuted) return;

    this.buffer += token;
    this.fullText += token;

    // Check for thinking tag transitions
    // Detect opening thinking tags
    if (/<think>/i.test(this.buffer) || /\[think\]/i.test(this.buffer)) {
      if (!this.insideThinking) {
        log.ttsSkipped('Skipping thinking block');
      }
      this.insideThinking = true;
      // Remove everything from opening tag onwards
      this.buffer = this.buffer.replace(/<think>[\s\S]*/i, '').replace(/\[think\][\s\S]*/i, '');
    }

    // Detect closing thinking tags
    if (this.insideThinking) {
      if (/<\/think>/i.test(this.buffer) || /\[\/think\]/i.test(this.buffer)) {
        this.insideThinking = false;
        // Keep only content after closing tag
        this.buffer = this.buffer.replace(/[\s\S]*<\/think>/i, '').replace(/[\s\S]*\[\/think\]/i, '');
      } else {
        // Still inside thinking, clear buffer and wait
        this.buffer = '';
        return;
      }
    }

    // Track fenced code blocks using fence count parity across ALL accumulated text.
    // Odd fence count = inside code block, even = outside.
    // This is reliable regardless of how tokens split across buffer flushes.
    const fenceCount = (this.fullText.match(/```/g) || []).length;
    const wasInsideCodeBlock = this.insideCodeBlock;
    this.insideCodeBlock = fenceCount % 2 === 1;

    if (this.insideCodeBlock) {
      // Inside a code block — discard buffer, don't speak anything
      this.buffer = '';
      return;
    }

    // Just exited a code block — clean up buffer (remove code remnants before the closing fence)
    if (wasInsideCodeBlock && !this.insideCodeBlock && this.buffer.includes('```')) {
      const parts = this.buffer.split('```');
      this.buffer = parts[parts.length - 1]; // keep only text after the last fence
      if (!this.buffer.trim()) {
        this.buffer = '';
        return;
      }
    }

    // Check for sentence boundary
    if (isSentenceEnd(this.buffer)) {
      const text = stripForTTS(this.buffer.trim());
      if (text.length > 0) {
        this.sendToTTS(text);
      }
      this.buffer = '';
    } else if (this.buffer.length > 600) {
      // Large chunk delivered at once — the server buffers post-tool replies
      // for repeat/dedup checks and flushes the WHOLE reply as one content
      // event. Speaking that as a single monolithic TTS request stalls
      // Chatterbox (perceived as "TTS stopped working"). Split into complete
      // sentences, grouped into ~350-char requests; the unterminated tail
      // stays buffered for the next event or flush().
      // Code fences: sentence-splitting could cut a ``` block across groups
      // and leak code fragments past stripForTTS (which strips only complete
      // fences) — defer to flush(), which strips the buffer as one piece.
      if (this.buffer.includes('```')) return;
      const pieces = this.buffer.match(/[\s\S]*?[.!?…](?:["')\]]*)(?:\s+|$)/g) || [];
      if (pieces.length > 0) {
        let group = '';
        for (const piece of pieces) {
          group += piece;
          if (group.length >= 350) {
            const text = stripForTTS(group.trim());
            if (text.length > 0) this.sendToTTS(text);
            group = '';
          }
        }
        // Speak the final sub-350 group of complete sentences too — with
        // buffered delivery there may be no further tokens coming.
        if (group.trim()) {
          const text = stripForTTS(group.trim());
          if (text.length > 0) this.sendToTTS(text);
        }
        this.buffer = this.buffer.slice(pieces.join('').length);
      }
      // No sentence punctuation at all yet → keep buffering; flush() handles it.
    }
  }

  // Flush any remaining buffered text
  flush() {
    if (this.disposed) return;
    if (this.buffer.trim().length > 0) {
      const text = stripForTTS(this.buffer.trim());
      if (text.length > 0) {
        this.sendToTTS(text);
      }
      this.buffer = '';
    }
  }

  // Reset buffer and queue for a new iteration (drops unsent text but lets current audio finish)
  reset() {
    this.buffer = '';
    this.fullText = '';
    this.insideThinking = false;
    this.insideCodeBlock = false;
    // Drop queued-but-unsent sentences from the previous iteration.
    // Reassigning ttsQueue alone does NOT do this — continuations already
    // chained on the old promise still run (C-44: a loop-generating iteration
    // queued ~a minute of speech that kept playing straight through the
    // reset). The generation bump is what actually cancels them.
    this.generation++;
    this.audioQueue = [];
    this.ttsQueue = Promise.resolve();
  }

  // Stop current playback and clear queue
  stop() {
    // Stop current audio
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio.src = '';
      this.currentAudio = null;
    }

    // Clear queue and state
    this.generation++; // cancels continuations still chained on the old ttsQueue
    this.audioQueue = [];
    this.buffer = '';
    this.isPlaying = false;
    this.insideThinking = false;
    this.insideCodeBlock = false;
    this.fullText = '';
    this.ttsQueue = Promise.resolve();
    this.onSpeakingChange?.(false);
  }

  private sendToTTS(text: string) {
    // Chain each TTS request so they execute one at a time (server can't
    // handle concurrency). Capture the generation at enqueue time: reset()/
    // stop() bump it, and a stale closure must do nothing — the old chain
    // itself cannot be cancelled once .then() has attached to it.
    const gen = this.generation;
    this.ttsQueue = this.ttsQueue.then(() => this.doSendToTTS(text, gen)).catch(() => {});
  }

  private async doSendToTTS(text: string, gen: number) {
    if (this.disposed || this.isMuted) return;
    if (gen !== this.generation) return; // superseded by reset()/stop()

    const startTime = Date.now();
    log.ttsRequest(text, this.voiceId);

    try {
      const response = await fetch('/api/tts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: text,
          voice: this.voiceId,
          endpoint: this.endpoint,
          speed: this.speed,
        }),
      });

      if (!response.ok) {
        log.ttsError(`Request failed: ${response.status}`);
        return;
      }

      const data = await response.json();

      if (!data.success || !data.audio) {
        log.ttsError(data.error || 'No audio data received');
        return;
      }

      // Log successful response with full text for expansion
      const audioBytes = Math.round((data.audio.length * 3) / 4); // Base64 to bytes estimate
      log.ttsResponse(audioBytes, Date.now() - startTime, text);

      // Create Audio element from base64 (same as old working app)
      const audio = new Audio(`data:audio/wav;base64,${data.audio}`);

      // Pre-decode so playback starts without a gap.
      await new Promise<void>((resolve) => {
        audio.oncanplaythrough = () => resolve();
        audio.onerror = () => resolve();
        audio.load();
      });

      // The fetch + decode above take seconds; a reset()/stop() may have
      // landed mid-flight. Never surface audio from a stale generation.
      if (gen !== this.generation) return;

      // If onAudioReady is set AND returns true, it handled the audio (live mode).
      // Otherwise, queue for normal playback.
      const handled = this.onAudioReady?.(data.audio, audio) ?? false;

      if (!handled) {
        this.audioQueue.push({ audio });
        if (!this.isPlaying && !this.isMuted) {
          this.playNext();
        }
      }
    } catch (error) {
      log.ttsError(error instanceof Error ? error.message : 'Unknown error');
    }
  }

  private async playNext() {
    if (this.audioQueue.length === 0 || this.isMuted) {
      this.isPlaying = false;
      this.onSpeakingChange?.(false);
      return;
    }

    this.isPlaying = true;
    this.onSpeakingChange?.(true);

    const entry = this.audioQueue.shift()!;
    const audio = entry.audio;
    this.currentAudio = audio;

    try {
      // Hold the global audio lock while this clip plays so a group-room voice
      // can't play over a 1:1 reply (and vice versa) — across tabs too.
      await withAudioLock(() => new Promise<void>((resolve) => {
        let hasResolved = false;

        const finish = () => {
          if (!hasResolved) {
            hasResolved = true;
            resolve();
          }
        };

        audio.onended = finish;
        audio.onerror = finish;

        // Backup trigger: resolve slightly before end to reduce gaps
        audio.ontimeupdate = () => {
          if (audio.duration && audio.currentTime >= audio.duration - 0.05) {
            finish();
          }
        };

        audio.play().catch(finish);
      }));

      // Tiny delay to prevent audio glitches
      await new Promise((resolve) => setTimeout(resolve, 20));
    } catch (error) {
      console.error('TTS playback error:', error);
    }

    this.currentAudio = null;
    this.playNext();
  }

  // Health check
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.endpoint}/v1/voices`, { method: 'GET' });
      return response.ok;
    } catch {
      return false;
    }
  }
}

// Speak a single text string (non-streaming)
export async function speakText(
  text: string,
  settings: TTSSettings
): Promise<void> {
  const cleanText = stripForTTS(text);
  if (!cleanText) return;

  try {
    // Use server-side proxy
    const response = await fetch('/api/tts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: cleanText,
        voice: settings.defaultVoice,
        endpoint: settings.endpoint,
        speed: settings.speed,
      }),
    });

    if (!response.ok) {
      throw new Error(`TTS request failed: ${response.status}`);
    }

    const data = await response.json();

    if (!data.success || !data.audio) {
      throw new Error(data.error || 'TTS failed');
    }

    const audio = new Audio(`data:audio/wav;base64,${data.audio}`);

    // Return promise that resolves when audio finishes
    return new Promise((resolve) => {
      audio.onended = () => resolve();
      audio.onerror = () => resolve();
      audio.play().catch(() => resolve());
    });
  } catch (error) {
    console.error('TTS error:', error);
  }
}
