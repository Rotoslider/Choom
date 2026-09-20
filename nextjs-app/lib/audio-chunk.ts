/**
 * Split a long 16 kHz mono PCM WAV at silences into ≤ MAX_CHUNK_SECONDS pieces
 * so each goes to Whisper as its own request.
 *
 * Why: Rapid-MLX conditions every 30 s Whisper window on the text of the
 * previous one and decodes at a single temperature with no fallback (checked
 * in 0.14.2 and 0.14.3 — deliberate upstream). Once a window locks into a
 * loop, every later window inherits it: a 99 s mic recording on 2026-09-20
 * lost its last third to "Access all of the... " ×110. Independent chunks
 * cannot inherit anything, so a loop costs at most one chunk, and the
 * repetition guard trims that.
 *
 * Silence points come from ffmpeg's silencedetect; the cut lands in the
 * middle of the silence so no word is split. When a stretch has no silence
 * at all, it is hard-cut at the limit (Whisper would have windowed there
 * anyway).
 */
import { spawn } from 'child_process';
import { ffmpegPath } from './audio-transcode';

export const MAX_CHUNK_SECONDS = 28;
export const MIN_CHUNK_SECONDS = 4;

export interface WavInfo { sampleRate: number; channels: number; bitsPerSample: number; dataOffset: number; dataLength: number; seconds: number }

/** Parse the header of a canonical/extended RIFF WAV. Returns null when it is not PCM WAV. */
export function parseWav(buf: Buffer): WavInfo | null {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let off = 12; let fmt: { sampleRate: number; channels: number; bits: number } | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4); const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(off + 10), sampleRate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    else if (id === 'data' && fmt) {
      const dataLength = Math.min(size, buf.length - off - 8);
      const bytesPerSec = fmt.sampleRate * fmt.channels * (fmt.bits / 8);
      return { sampleRate: fmt.sampleRate, channels: fmt.channels, bitsPerSample: fmt.bits, dataOffset: off + 8, dataLength, seconds: dataLength / bytesPerSec };
    }
    off += 8 + size + (size % 2);
  }
  return null;
}

/** Parse ffmpeg silencedetect stderr into [start, end] pairs (seconds). */
export function parseSilences(stderr: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start: number | null = null;
  for (const m of stderr.matchAll(/silence_(start|end): ([\d.]+)/g)) {
    const t = parseFloat(m[2]);
    if (m[1] === 'start') start = t;
    else if (start !== null) { out.push([start, t]); start = null; }
  }
  return out;
}

/**
 * Choose cut points (seconds). Greedy: from the current start, take the LAST
 * silence midpoint that keeps the chunk ≤ max; if none, hard-cut at max.
 * A trailing remainder shorter than `min` is merged into the previous chunk
 * when that stays within max + min (Whisper pads to 30 s anyway).
 */
export function planCuts(totalSeconds: number, silences: Array<[number, number]>, max = MAX_CHUNK_SECONDS, min = MIN_CHUNK_SECONDS): number[] {
  if (totalSeconds <= max) return [];
  const mids = silences.map(([a, b]) => (a + b) / 2).filter(t => t > 0 && t < totalSeconds).sort((a, b) => a - b);
  const cuts: number[] = [];
  let start = 0;
  while (totalSeconds - start > max) {
    const candidates = mids.filter(t => t > start + min && t <= start + max);
    const cut = candidates.length ? candidates[candidates.length - 1] : start + max;
    cuts.push(cut);
    start = cut;
  }
  if (cuts.length && totalSeconds - cuts[cuts.length - 1] < min && totalSeconds - (cuts[cuts.length - 2] ?? 0) <= max + min) cuts.pop();
  return cuts;
}

/** Slice a PCM WAV into new standalone WAV buffers at the given cut times. */
export function sliceWav(buf: Buffer, info: WavInfo, cuts: number[]): Buffer[] {
  const frame = info.channels * (info.bitsPerSample / 8);
  const toByte = (sec: number) => Math.min(info.dataLength, Math.floor(sec * info.sampleRate) * frame);
  const bounds = [0, ...cuts.map(toByte), info.dataLength];
  const pieces: Buffer[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const data = buf.subarray(info.dataOffset + bounds[i], info.dataOffset + bounds[i + 1]);
    if (data.length === 0) continue;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
    header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
    header.writeUInt16LE(info.channels, 22); header.writeUInt32LE(info.sampleRate, 24);
    header.writeUInt32LE(info.sampleRate * frame, 28); header.writeUInt16LE(frame, 32); header.writeUInt16LE(info.bitsPerSample, 34);
    header.write('data', 36); header.writeUInt32LE(data.length, 40);
    pieces.push(Buffer.concat([header, data]));
  }
  return pieces;
}

/** Run ffmpeg silencedetect on a WAV buffer; empty list on any failure (then we hard-cut). */
export function detectSilences(wav: Buffer, noiseDb = -35, minSilenceSec = 0.6, timeoutMs = 30_000): Promise<Array<[number, number]>> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath(), ['-loglevel', 'info', '-i', 'pipe:0', '-af', `silencedetect=noise=${noiseDb}dB:d=${minSilenceSec}`, '-f', 'null', '-']);
    const err: Buffer[] = [];
    const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve([]); }, timeoutMs);
    proc.stderr.on('data', d => err.push(d));
    proc.on('error', () => { clearTimeout(timer); resolve([]); });
    proc.on('close', () => { clearTimeout(timer); resolve(parseSilences(Buffer.concat(err).toString())); });
    proc.stdin.on('error', () => { /* close handler resolves */ });
    proc.stdin.end(wav);
  });
}

/** Full pipeline: returns [wav] untouched when short enough, else the chunks. */
export async function chunkWavAtSilences(wav: Buffer, max = MAX_CHUNK_SECONDS): Promise<{ chunks: Buffer[]; seconds: number; cuts: number[] }> {
  const info = parseWav(wav);
  if (!info || info.seconds <= max) return { chunks: [wav], seconds: info?.seconds ?? 0, cuts: [] };
  const silences = await detectSilences(wav);
  const cuts = planCuts(info.seconds, silences, max);
  return { chunks: cuts.length ? sliceWav(wav, info, cuts) : [wav], seconds: info.seconds, cuts };
}
