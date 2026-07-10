import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { stripForTTS } from '@/lib/utils';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

// GET /api/tts/message/<id>[?kind=group]
//
// Returns the full TTS audio for one saved message (1:1 assistant message, or
// a Choom-authored group-room message) as a single WAV, generated on demand in
// the message author's voice and cached on disk — so past conversations (e.g.
// rooms the Chooms ran on their own) can be listened to any time, and replays
// are instant. Live streaming TTS is unaffected; this is the "play this
// response" button's backend.

const CACHE_DIR = path.join(process.cwd(), 'data', 'tts-cache');

// Chatterbox crashes under burst load (see /api/tts circuit breaker), so
// chunks are synthesized STRICTLY sequentially.
const CHUNK_TARGET = 350; // chars per synthesis request

function chunkForTTS(text: string, target = CHUNK_TARGET): string[] {
  const pieces = text.match(/[\s\S]*?[.!?…](?:["')\]]*)(?:\s+|$)/g) || [];
  const chunks: string[] = [];
  let group = '';
  for (const p of pieces) {
    group += p;
    if (group.length >= target) {
      chunks.push(group.trim());
      group = '';
    }
  }
  group += text.slice(pieces.join('').length); // unterminated tail
  if (group.trim()) chunks.push(group.trim());
  return chunks;
}

// Minimal RIFF/WAV parsing — concatenate same-format WAV chunks into one file
// by joining their data payloads under the first chunk's fmt header.
function findChunk(buf: Buffer, id: string): { offset: number; size: number } | null {
  let pos = 12; // past "RIFF<size>WAVE"
  while (pos + 8 <= buf.length) {
    const cid = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (cid === id) return { offset: pos + 8, size: Math.min(size, buf.length - pos - 8) };
    pos += 8 + size + (size % 2); // chunks are word-aligned
  }
  return null;
}

function concatWavs(wavs: Buffer[]): Buffer {
  const first = wavs[0];
  const fmt = findChunk(first, 'fmt ');
  if (!fmt) throw new Error('fmt chunk missing in TTS output');
  const dataParts = wavs.map((w) => {
    const d = findChunk(w, 'data');
    if (!d) throw new Error('data chunk missing in TTS output');
    return w.subarray(d.offset, d.offset + d.size);
  });
  const dataSize = dataParts.reduce((s, p) => s + p.length, 0);
  const header = Buffer.alloc(28 + fmt.size);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(4 + 8 + fmt.size + 8 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(fmt.size, 16);
  first.copy(header, 20, fmt.offset, fmt.offset + fmt.size);
  header.write('data', 20 + fmt.size, 'ascii');
  header.writeUInt32LE(dataSize, 24 + fmt.size);
  return Buffer.concat([header, ...dataParts]);
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const kind = request.nextUrl.searchParams.get('kind') === 'group' ? 'group' : 'chat';

    // Resolve message text + speaking Choom's voice
    let text: string | null = null;
    let voiceId: string | null = null;
    if (kind === 'group') {
      const msg = await prisma.groupMessage.findUnique({
        where: { id },
        include: { author: { select: { voiceId: true } } },
      });
      if (!msg || !msg.authorChoomId) {
        return NextResponse.json({ error: 'Group message not found or not Choom-authored' }, { status: 404 });
      }
      text = msg.content;
      voiceId = msg.author?.voiceId || null;
    } else {
      const msg = await prisma.message.findUnique({
        where: { id },
        include: { chat: { include: { choom: { select: { voiceId: true } } } } },
      });
      if (!msg || msg.role !== 'assistant') {
        return NextResponse.json({ error: 'Message not found or not an assistant message' }, { status: 404 });
      }
      text = msg.content;
      voiceId = msg.chat?.choom?.voiceId || null;
    }

    // Global TTS settings (endpoint/speed/default voice)
    let ttsEndpoint = process.env.TTS_ENDPOINT || 'http://localhost:8004';
    let speed = 1.0;
    let defaultVoice = 'sophie';
    try {
      const settingsRow = await prisma.settings.findUnique({ where: { id: 'global' } });
      if (settingsRow?.tts) {
        const tts = JSON.parse(settingsRow.tts) as { endpoint?: string; speed?: number; defaultVoice?: string };
        if (tts.endpoint) ttsEndpoint = tts.endpoint;
        if (typeof tts.speed === 'number' && tts.speed > 0) speed = tts.speed;
        if (tts.defaultVoice) defaultVoice = tts.defaultVoice;
      }
    } catch { /* fall back to defaults */ }
    const voice = voiceId || defaultVoice;

    const spoken = stripForTTS(text || '');
    if (!spoken.trim()) {
      return NextResponse.json({ error: 'Nothing speakable in this message' }, { status: 404 });
    }

    // Cache key covers everything that affects the audio — message edits,
    // voice reassignment, and speed changes all produce a fresh file.
    const hash = createHash('sha1').update(`${spoken}|${voice}|${speed}`).digest('hex').slice(0, 10);
    const cachePath = path.join(CACHE_DIR, `${kind}-${id}-${hash}.wav`);

    if (fs.existsSync(cachePath)) {
      const cached = fs.readFileSync(cachePath);
      return new NextResponse(new Uint8Array(cached), {
        headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'private, max-age=31536000' },
      });
    }

    // Synthesize sequentially (Chatterbox crashes under burst load)
    const chunks = chunkForTTS(spoken);
    const wavs: Buffer[] = [];
    for (const chunk of chunks) {
      const res = await fetch(`${ttsEndpoint}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'chatterbox', input: chunk, voice, response_format: 'wav', speed }),
      });
      if (!res.ok || !res.headers.get('content-type')?.includes('audio')) {
        const detail = await res.text().catch(() => '');
        console.error(`   🔊 Message TTS chunk failed (${res.status}): ${detail.slice(0, 200)}`);
        return NextResponse.json({ error: `TTS service error: ${res.status}` }, { status: 502 });
      }
      wavs.push(Buffer.from(await res.arrayBuffer()));
    }

    const full = wavs.length === 1 ? wavs[0] : concatWavs(wavs);

    fs.mkdirSync(CACHE_DIR, { recursive: true });
    // Write via temp+rename so a concurrent request never reads a partial file
    const tmpPath = `${cachePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmpPath, full);
    fs.renameSync(tmpPath, cachePath);
    console.log(`   🔊 Message TTS cached: ${kind}/${id} — ${chunks.length} chunk(s), ${(full.length / 1024).toFixed(0)} KB, voice=${voice}`);

    return new NextResponse(new Uint8Array(full), {
      headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'private, max-age=31536000' },
    });
  } catch (error) {
    console.error('Message TTS failed:', error);
    return NextResponse.json({ error: 'Failed to generate message audio' }, { status: 500 });
  }
}
