/**
 * Browser side of the voice hand-off to the Looking Glass hologram. While the hologram is
 * speaking for the Chooms, this browser stays quiet: otherwise every reply is heard twice and
 * Chatterbox renders every sentence twice. The server decides whether this browser is at home
 * (/api/hologram/voice); away from home (through ngrok) the browser keeps its own voice.
 *
 * The mute button reaches the hologram too: this module registers as an audio player, so
 * broadcastMute() tells the hologram to stop talking. Only changes are sent, never the
 * initial sync on page load, so opening a page can't override the hologram's state.
 * Per-message play buttons are unaffected.
 *
 * Each poll also says which chat or room this page has open (setHologramViewing): like the web
 * app, the hologram speaks a conversation only while someone at home has it open.
 */
import { registerAudioPlayer } from './audio-registry';

let active = false;
let lastMuted: boolean | null = null;
let viewing: { chat?: string | null; room?: string | null } = {};

async function refresh(): Promise<void> {
  try {
    const q = new URLSearchParams();
    if (viewing.chat) q.set('chat', viewing.chat);
    if (viewing.room) q.set('room', viewing.room);
    const qs = q.toString();
    const res = await fetch(`/api/hologram/voice${qs ? `?${qs}` : ''}`, { cache: 'no-store' });
    active = res.ok && (await res.json()).voice === true;
  } catch {
    active = false;
  }
}

if (typeof window !== 'undefined') {
  void refresh();
  setInterval(refresh, 10_000);
  registerAudioPlayer({
    setMuted(muted: boolean) {
      const changed = lastMuted !== null && muted !== lastMuted;
      lastMuted = muted;
      if (!changed) return;
      void fetch('/api/hologram/mute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ muted }),
      }).catch(() => {});
      // The hologram's voice state changes with mute; pick it up without waiting for the poll.
      setTimeout(() => void refresh(), 1500);
    },
  });
}

/** Tell the hologram which conversation this page has open (null/empty when none). */
export function setHologramViewing(v: { chat?: string | null; room?: string | null }): void {
  viewing = v;
  if (typeof window !== 'undefined') void refresh();
}

/** True when the hologram is speaking for the Chooms, so this browser should not. */
export function hologramHasVoice(): boolean {
  return active;
}
