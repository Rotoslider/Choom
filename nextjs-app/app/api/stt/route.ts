import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

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

    // Use local whisper-fastapi server (OpenAI-compatible endpoint)
    const sttEndpoint = endpoint ?? process.env.STT_ENDPOINT ?? 'http://localhost:5000';

    // Convert audio to buffer
    const audioBuffer = await audioFile.arrayBuffer();

    // Send to Whisper FastAPI server using OpenAI-compatible endpoint
    const sttFormData = new FormData();
    sttFormData.append('file', new Blob([audioBuffer]), 'audio.webm');
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
          hint: 'Please ensure whisper-fastapi is running on port 5000',
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
      hint: 'Start whisper-fastapi server on port 5000',
      details: String(error),
    });
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get('action');
    const endpoint = searchParams.get('endpoint') ?? 'http://localhost:5000';

    if (action === 'health') {
      try {
        // Check if whisper-fastapi is responding
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
