import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// ── Circuit breaker for TTS server ──────────────────────────────────────────
// Chatterbox TTS can crash under burst load (observed: ~7 successful requests
// in 10s, then "other side closed" on every subsequent call until the service
// is manually restarted). Without a breaker we keep hammering the dead socket
// for every sentence the LLM produces, flooding logs and adding latency.
//
// State: trip after N consecutive failures, stay tripped for COOLDOWN_MS, then
// allow ONE half-open probe. Probe success → close. Probe failure → re-trip.
const FAILURE_THRESHOLD = 3;
const COOLDOWN_MS = 30_000;
let consecutiveFailures = 0;
let trippedUntil = 0;
let halfOpenInFlight = false;

function isTripped(): boolean {
  if (trippedUntil === 0) return false;
  if (Date.now() >= trippedUntil) {
    // Cooldown elapsed — allow exactly one half-open probe.
    if (halfOpenInFlight) return true;
    halfOpenInFlight = true;
    return false;
  }
  return true;
}
function recordSuccess() {
  consecutiveFailures = 0;
  trippedUntil = 0;
  halfOpenInFlight = false;
}
function recordFailure() {
  consecutiveFailures += 1;
  if (halfOpenInFlight) {
    // Probe failed — re-arm the cooldown and keep the breaker open.
    halfOpenInFlight = false;
    trippedUntil = Date.now() + COOLDOWN_MS;
    console.warn(`🚧 TTS circuit breaker re-tripped (probe failed). Cooldown ${COOLDOWN_MS / 1000}s.`);
    return;
  }
  if (consecutiveFailures >= FAILURE_THRESHOLD && trippedUntil === 0) {
    trippedUntil = Date.now() + COOLDOWN_MS;
    console.warn(`🚧 TTS circuit breaker TRIPPED after ${consecutiveFailures} consecutive failures. Cooldown ${COOLDOWN_MS / 1000}s. Restart the TTS server (port 8004) and the breaker will half-open on the next request after cooldown.`);
  }
}

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

    if (isTripped()) {
      const remainingMs = Math.max(0, trippedUntil - Date.now());
      return NextResponse.json({
        success: false,
        error: 'TTS service unavailable (circuit breaker open)',
        details: `Skipping request — TTS server has been failing. Cooldown remaining: ${Math.round(remainingMs / 1000)}s. Restart chatterbox on port 8004 to recover.`,
        circuitBreaker: 'open',
      }, { status: 503 });
    }

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
      // 5xx counts toward the breaker; 4xx is client-side, don't trip on those.
      if (response.status >= 500) recordFailure();
      return NextResponse.json({
        success: false,
        error: `TTS service error: ${response.status}`,
        details: errorText,
      }, { status: response.status });
    }

    const contentType = response.headers.get('content-type');
    if (!contentType?.includes('audio')) {
      console.error('TTS response is not audio data:', contentType);
      recordFailure();
      return NextResponse.json({
        success: false,
        error: 'Invalid response from TTS server',
      }, { status: 500 });
    }

    const audioBuffer = await response.arrayBuffer();
    const base64Audio = Buffer.from(audioBuffer).toString('base64');

    console.log(`🔊 TTS Success: ${audioBuffer.byteLength} bytes`);
    recordSuccess();

    return NextResponse.json({
      success: true,
      audio: base64Audio,
      format: 'wav',
    });

  } catch (error) {
    console.error('TTS Connection Error:', error);
    recordFailure();
    return NextResponse.json({
      success: false,
      error: 'Failed to connect to TTS server',
      details: String(error),
    }, { status: 500 });
  }
}
