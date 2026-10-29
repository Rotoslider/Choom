/** Her voice as Opus for a listener away from home (lib/audio-transcode.ts toOpus, /api/tts). */
import { NextRequest } from 'next/server';
import { toOpus } from '@/lib/audio-transcode';
import { POST as tts } from '@/app/api/tts/route';

jest.setTimeout(30_000);

/** One second of a 220 Hz tone as 24 kHz 16-bit mono WAV, the way Chatterbox sends speech. */
function wav(seconds = 1, rate = 24000): Buffer {
  const n = seconds * rate, data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / rate)), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

test('Opus is a fraction of the WAV', async () => {
  const source = wav();
  const opus = await toOpus(source);
  expect(opus.toString('ascii', 0, 4)).toBe('OggS');
  expect(opus.length).toBeLessThan(source.length / 5);
});

describe('/api/tts', () => {
  beforeEach(() => {
    global.fetch = jest.fn(async () => new Response(new Uint8Array(wav()), { headers: { 'content-type': 'audio/wav' } })) as never;
  });
  const ask = (body: unknown, headers: Record<string, string>) =>
    tts(new NextRequest('http://localhost:3000/api/tts', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers } }));

  test('away from home, for a player that plays Opus: Opus', async () => {
    const data = await (await ask({ text: 'Hello there.', voice: 'sophie', formats: ['opus'] }, { host: 'donnys-mac-studio:3000', 'x-forwarded-for': '100.111.61.8' })).json();
    expect(data).toMatchObject({ success: true, format: 'opus', mimeType: 'audio/ogg' });
    expect(Buffer.from(data.audio, 'base64').toString('ascii', 0, 4)).toBe('OggS');
  });

  test('at home, or a player that plays only WAV: WAV as before', async () => {
    const home = await (await ask({ text: 'Hello there.', formats: ['opus'] }, { host: 'localhost:3000' })).json();
    expect(home).toMatchObject({ success: true, format: 'wav' });
    expect(home.mimeType).toBeUndefined();
    const plain = await (await ask({ text: 'Hello there.' }, { host: 'donnys-mac-studio:3000', 'x-forwarded-for': '100.111.61.8' })).json();
    expect(plain).toMatchObject({ success: true, format: 'wav' });
  });
});
