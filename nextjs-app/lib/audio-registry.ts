/**
 * Global registry of every live audio player: 1:1 streaming TTS, room TTS
 * queues, per-message play buttons.
 *
 * The mute button must silence AUDIO, not "whichever instance the current
 * page holds a ref to". Live incident (2026-08-06): a long agentic turn kept
 * feeding an orphaned StreamingTTS after the user hopped 1:1 → room → 1:1 —
 * the remount created a fresh instance, so the mute button muted the new,
 * silent one while the orphan kept talking for minutes. Broadcasting through
 * this registry reaches orphans too.
 */
type MutablePlayer = { setMuted(muted: boolean): void };

const players = new Set<MutablePlayer>();

/** Register a player; returns an unregister function (call it on dispose). */
export function registerAudioPlayer(p: MutablePlayer): () => void {
  players.add(p);
  return () => players.delete(p);
}

/** Apply mute/unmute to every registered player, orphaned or not. */
export function broadcastMute(muted: boolean): void {
  for (const p of players) {
    try { p.setMuted(muted); } catch { /* one broken player must not block the rest */ }
  }
}
