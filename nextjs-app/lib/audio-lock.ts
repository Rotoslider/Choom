// Global audio playback lock — serializes EVERY Choom voice clip so two can
// never play over each other, even across different TTS sources and across
// browser tabs of the same origin.
//
// The bug this fixes: a 1:1 chat reply (StreamingTTS) auto-played while a group
// room (RoomTTSQueue) was still speaking, so the two audio streams overlapped
// and scrambled. Each queue already serializes its OWN clips, but they had no
// knowledge of each other. The Web Locks API gives us a single named lock that
// spans both queues and every tab, so playback is strictly one-at-a-time.
//
// Falls back to running the callback directly when the Web Locks API is missing
// (older browsers / insecure contexts) — i.e. previous behavior, no worse.

const AUDIO_LOCK_NAME = 'choom-tts-audio';

interface LockManagerLike {
  request: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
}

export async function withAudioLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks: LockManagerLike | undefined =
    typeof navigator !== 'undefined'
      ? (navigator as unknown as { locks?: LockManagerLike }).locks
      : undefined;
  if (!locks?.request) return fn();
  // navigator.locks.request resolves with the callback's return value and
  // releases the lock automatically once the callback's promise settles.
  return locks.request(AUDIO_LOCK_NAME, fn) as Promise<T>;
}
