import { NextRequest, NextResponse } from 'next/server';
import { toWav } from '@/lib/audio-transcode';

export const dynamic = 'force-dynamic';
const DEFAULT_STT = 'http://localhost:8890'; // the Mac's Rapid-MLX (/v1/audio/transcriptions)

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const audioFile = formData.get('audio') as File | null;
    const endpoint = formData.get('endpoint') as string | null;

    if (!audioFile) {
      return NextResponse.json(
        { error: 'Audio file is required' },
        { status: 400 }
      );
    }

    // OpenAI-compatible transcription endpoint (Rapid-MLX on the Mac by default)
    const sttEndpoint = endpoint ?? process.env.STT_ENDPOINT ?? DEFAULT_STT;

    // The browser records WebM/Opus; the server decodes WAV. Transcode here.
    const raw = Buffer.from(await audioFile.arrayBuffer());
    let wav: Buffer;
    try {
      wav = await toWav(raw);
    } catch (err) {
      console.error('🎤 STT transcode failed:', err instanceof Error ? err.message : err);
      return NextResponse.json({ success: false, error: 'Could not convert the recording to WAV', details: String(err) }, { status: 500 });
    }

    const sttFormData = new FormData();
    sttFormData.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav');
    sttFormData.append('response_format', 'json');

    console.log(`🎤 STT request to ${sttEndpoint}/v1/audio/transcriptions`);

    const response = await fetch(`${sttEndpoint}/v1/audio/transcriptions`, {
      method: 'POST',
      body: sttFormData,
    });

    console.log(`🎤 STT response status: ${response.status}`);

    if (!response.ok) {
      if (response.status === 404 || response.status === 502) {
        return NextResponse.json({
          success: false,
          error: 'STT service not available',
          hint: 'Check the STT endpoint in Settings — the Mac default is Rapid-MLX on port 8890',
        });
      }

      const errorText = await response.text().catch(() => 'Unknown error');
      return NextResponse.json(
        { success: false, error: `STT error: ${response.status}`, details: errorText },
        { status: response.status }
      );
    }

    const data = await response.json();
    console.log(`🎤 STT transcription: "${data?.text?.slice(0, 100)}${data?.text?.length > 100 ? '...' : ''}"`);

    return NextResponse.json({
      success: true,
      text: data?.text ?? '',
    });
  } catch (error) {
    console.error('🎤 STT error:', error);
    return NextResponse.json({
      success: false,
      error: 'STT service connection failed',
      hint: 'Check the STT endpoint in Settings — the Mac default is Rapid-MLX on port 8890',
      details: String(error),
    });
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get('action');
    const endpoint = searchParams.get('endpoint') ?? DEFAULT_STT;

    if (action === 'health') {
      try {
        // Check if the transcription server is responding
        const response = await fetch(`${endpoint}/v1/audio/transcriptions`, {
          method: 'HEAD',
          signal: AbortSignal.timeout(5000),
        });

        // 405 Method Not Allowed means server is up (doesn't support HEAD)
        if (response.ok || response.status === 405 || response.status === 422) {
          return NextResponse.json({ status: 'connected' });
        }
        return NextResponse.json({ status: 'disconnected' });
      } catch {
        return NextResponse.json({ status: 'disconnected' });
      }
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (error) {
    console.error('🎤 STT GET error:', error);
    return NextResponse.json({ success: false, error: String(error) });
  }
}
