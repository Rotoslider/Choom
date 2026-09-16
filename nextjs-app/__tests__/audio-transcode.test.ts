/** 2026-09-16: mic (WebM/Opus) and Signal (Ogg/Opus) audio must reach Rapid-MLX as WAV. */
import { spawnSync } from 'child_process';
import { isWav, toWav, ffmpegPath } from '@/lib/audio-transcode';

function silentWav(seconds = 0.4, rate = 16000): Buffer {
  const n = Math.floor(seconds * rate); const data = Buffer.alloc(n * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const haveFfmpeg = spawnSync(ffmpegPath(), ['-version']).status === 0;

describe('toWav', () => {
  test('WAV passes through untouched', async () => {
    const w = silentWav();
    expect(isWav(w)).toBe(true);
    expect(await toWav(w)).toBe(w);
  });
  (haveFfmpeg ? test : test.skip)('WebM/Opus and Ogg/Opus become 16 kHz mono WAV', async () => {
    const w = silentWav();
    for (const fmt of ['webm', 'ogg']) {
      const enc = spawnSync(ffmpegPath(), ['-loglevel', 'error', '-i', 'pipe:0', '-c:a', 'libopus', '-f', fmt, 'pipe:1'], { input: w, maxBuffer: 1 << 24 });
      expect(enc.status).toBe(0);
      expect(isWav(enc.stdout)).toBe(false);
      const out = await toWav(enc.stdout);
      expect(isWav(out)).toBe(true);
      expect(out.readUInt32LE(24)).toBe(16000);
      expect(out.readUInt16LE(22)).toBe(1);
    }
  });
  test('garbage input rejects instead of hanging', async () => {
    if (!haveFfmpeg) return;
    await expect(toWav(Buffer.from('not audio at all'))).rejects.toThrow(/ffmpeg/);
  });
});
