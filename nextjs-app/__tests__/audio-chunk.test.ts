/**
 * audio-chunk — cut long WAVs at silences into ≤28 s pieces so a Whisper
 * loop in one window cannot run through the rest of a recording.
 */
import { parseWav, parseSilences, planCuts, sliceWav } from '../lib/audio-chunk';

function makeWav(seconds: number, sampleRate = 16000): Buffer {
  const data = Buffer.alloc(seconds * sampleRate * 2);
  for (let i = 0; i < data.length / 2; i++) data.writeInt16LE(Math.round(Math.sin(i / 20) * 8000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

describe('parseWav', () => {
  it('reads format and duration', () => {
    const info = parseWav(makeWav(10))!;
    expect(info.sampleRate).toBe(16000);
    expect(info.channels).toBe(1);
    expect(info.seconds).toBeCloseTo(10, 5);
    expect(info.dataOffset).toBe(44);
  });
  it('rejects non-WAV', () => {
    expect(parseWav(Buffer.from('not a wav file at all, definitely not, no sir'))).toBeNull();
  });
});

describe('parseSilences', () => {
  it('pairs silence_start/end from ffmpeg stderr', () => {
    const stderr = `[silencedetect @ 0x1] silence_start: 7.4\n[silencedetect @ 0x1] silence_end: 14.9 | silence_duration: 7.5\nfoo\n[silencedetect @ 0x1] silence_start: 20.0\n[silencedetect @ 0x1] silence_end: 25.0 | silence_duration: 5\n`;
    expect(parseSilences(stderr)).toEqual([[7.4, 14.9], [20, 25]]);
  });
  it('ignores an unterminated trailing silence', () => {
    expect(parseSilences('silence_start: 3.0\n')).toEqual([]);
  });
});

describe('planCuts', () => {
  it('does not cut a recording within the limit', () => {
    expect(planCuts(28, [[10, 11]])).toEqual([]);
  });
  it('cuts at the last silence midpoint that fits, repeatedly', () => {
    // 99 s with pauses at ~20, ~45, ~70, ~90: after the cut at 70 s the
    // remaining 29 s still exceeds the limit, so the 90 s pause is used too.
    const cuts = planCuts(99, [[19.5, 20.5], [44.5, 45.5], [69.5, 70.5], [89.5, 90.5]]);
    expect(cuts).toEqual([20, 45, 70, 90]);
  });
  it('hard-cuts when a stretch has no silence', () => {
    expect(planCuts(60, [])).toEqual([28, 56]);
  });
  it('merges a tiny trailing remainder into the previous chunk', () => {
    // silence at 27 → cut there leaves 3 s at the end; better to keep one 30 s piece
    expect(planCuts(30, [[26.5, 27.5]])).toEqual([]);
  });
  it('never creates a chunk shorter than the minimum by choosing an early silence', () => {
    const cuts = planCuts(40, [[1, 2], [25, 26]]);
    expect(cuts).toEqual([25.5]);
  });
});

describe('sliceWav', () => {
  it('produces standalone WAVs whose durations add up', () => {
    const wav = makeWav(60);
    const info = parseWav(wav)!;
    const pieces = sliceWav(wav, info, [20, 45]);
    expect(pieces).toHaveLength(3);
    const secs = pieces.map(p => parseWav(p)!.seconds);
    expect(secs[0]).toBeCloseTo(20, 5);
    expect(secs[1]).toBeCloseTo(25, 5);
    expect(secs[2]).toBeCloseTo(15, 5);
    expect(pieces[1].readUInt32LE(40)).toBe(pieces[1].length - 44);
  });
});
