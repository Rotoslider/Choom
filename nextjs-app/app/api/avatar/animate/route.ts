import { NextRequest, NextResponse } from 'next/server';

const AVATAR_SERVICE_URL = process.env.AVATAR_SERVICE_URL || 'http://127.0.0.1:8020';

/**
 * POST /api/avatar/animate
 *
 * Sends audio + reference image to MuseTalk for talking head generation.
 * Returns an array of base64 JPEG frames.
 */
export async function POST(request: NextRequest) {
  try {
    const { choomId, imageBase64, audioBase64, includeAudio } = await request.json();

    if (!choomId || !audioBase64) {
      return NextResponse.json(
        { error: 'choomId and audioBase64 are required' },
        { status: 400 }
      );
    }

    const response = await fetch(`${AVATAR_SERVICE_URL}/animate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        choom_id: choomId,
        image_base64: imageBase64 || '',
        audio_base64: audioBase64,
        includeAudio: includeAudio || false,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      return NextResponse.json(
        { error: `Avatar animate failed: ${error}` },
        { status: 500 }
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('[Avatar] Animate error:', error);
    return NextResponse.json(
      { error: 'Failed to generate animation' },
      { status: 500 }
    );
  }
}
