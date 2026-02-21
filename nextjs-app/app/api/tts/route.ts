import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { text, voice, endpoint, speed } = body ?? {};

    if (!text?.trim()) {
      return NextResponse.json(
        { success: false, error: 'Text is required' },
        { status: 400 }
      );
    }

    const ttsEndpoint = endpoint ?? process.env.TTS_ENDPOINT ?? 'http://localhost:8004';
    const selectedVoice = voice ?? 'sophie';

    console.log(`🔊 TTS Request: ${ttsEndpoint}/v1/audio/speech | Voice: ${selectedVoice} | Text: "${text.substring(0, 50)}..."`);

    const response = await fetch(`${ttsEndpoint}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'chatterbox',
        input: text,
        voice: selectedVoice,
        response_format: 'wav',
        speed: speed ?? 1.0,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      console.error(`TTS API Error (${response.status}): ${errorText}`);
      return NextResponse.json({
        success: false,
        error: `TTS service error: ${response.status}`,
        details: errorText,
      }, { status: response.status });
    }

    const contentType = response.headers.get('content-type');
    if (!contentType?.includes('audio')) {
      console.error('TTS response is not audio data:', contentType);
      return NextResponse.json({
        success: false,
        error: 'Invalid response from TTS server',
      }, { status: 500 });
    }

    const audioBuffer = await response.arrayBuffer();
    const base64Audio = Buffer.from(audioBuffer).toString('base64');

    console.log(`🔊 TTS Success: ${audioBuffer.byteLength} bytes`);

    return NextResponse.json({
      success: true,
      audio: base64Audio,
      format: 'wav',
    });

  } catch (error) {
    console.error('TTS Connection Error:', error);
    return NextResponse.json({
      success: false,
      error: 'Failed to connect to TTS server',
      details: String(error),
    }, { status: 500 });
  }
}
