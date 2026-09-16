/**
 * Transcode any browser/Signal audio to 16 kHz mono WAV before it goes to the
 * transcription server (2026-09-16). Rapid-MLX's /v1/audio/transcriptions
 * decodes WAV only — a WebM/Opus mic recording or an Ogg/Opus Signal voice
 * note came back "could not decode audio file" — while the NUC's whisper
 * server used to decode anything through ffmpeg. Now we do that step here.
 */
import { spawn } from 'child_process';
import fs from 'fs';

export function isWav(buf: Buffer): boolean {
  return buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE';
}

export function ffmpegPath(): string {
  for (const p of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) {
    if (fs.existsSync(p)) return p;
  }
  return 'ffmpeg';
}

/** Returns the input untouched when it is already WAV; otherwise 16 kHz mono PCM WAV. */
export function toWav(input: Buffer, timeoutMs = 30_000): Promise<Buffer> {
  if (isWav(input)) return Promise.resolve(input);
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath(), ['-loglevel', 'error', '-i', 'pipe:0', '-ar', '16000', '-ac', '1', '-f', 'wav', 'pipe:1']);
    const out: Buffer[] = []; const err: Buffer[] = [];
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('ffmpeg timed out')); }, timeoutMs);
    proc.stdout.on('data', d => out.push(d));
    proc.stderr.on('data', d => err.push(d));
    proc.on('error', e => { clearTimeout(timer); reject(e); });
    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0 && out.length) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg exit ${code}: ${Buffer.concat(err).toString().slice(0, 300)}`));
    });
    proc.stdin.on('error', () => { /* ffmpeg closed early; close handler reports */ });
    proc.stdin.end(input);
  });
}
