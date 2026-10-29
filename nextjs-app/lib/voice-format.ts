/**
 * Her voice in a smaller format for a listener away from home (toOpus in lib/audio-transcode.ts): a
 * player says which formats it can play besides WAV, and the server compresses only for a request from
 * away. At home it stays WAV (nothing to save on the home network, and no time spent encoding).
 */

/** The formats this browser can play besides WAV. */
export function playableVoiceFormats(): string[] {
  try {
    return typeof Audio !== 'undefined' && new Audio().canPlayType('audio/ogg; codecs=opus') ? ['opus'] : [];
  } catch {
    return [];
  }
}

/** A data URL for audio from /api/tts (WAV unless it says otherwise). */
export const voiceDataUrl = (data: { audio: string; mimeType?: string }): string =>
  `data:${data.mimeType || 'audio/wav'};base64,${data.audio}`;

/** A saved message's audio link, asking for the smaller format when this browser plays it. */
export function withVoiceFormats(src: string): string {
  const formats = playableVoiceFormats();
  return formats.length ? `${src}${src.includes('?') ? '&' : '?'}formats=${formats.join(',')}` : src;
}
