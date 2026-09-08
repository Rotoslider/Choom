#!/usr/bin/env python3
"""
Chatterbox-compatible TTS shim in front of a Rapid-MLX server.

Choom (and Home Assistant) already speak the QUITE_CHATTER API:

    POST /v1/audio/speech  {"input": "...", "voice": "sophie"}  -> WAV
    GET  /v1/voices                                             -> {"voices": [...]}
    GET  /v1/info                                               -> name/paths

Rapid-MLX cannot serve that directly. It has no registry of cloned voices —
/v1/audio/voices lists only a model's *built-in* voices ("default" for
chatterbox) — so every request must carry the reference clip inline as base64
`ref_audio` plus its transcript in `ref_text`. This process owns that mapping:
one .wav + .txt pair per voice in VOICES_DIR, resolved by name.

References are pre-trimmed to ~12s / 24 kHz mono. Reference *length* dominates
synthesis time (30s -> 12s cut generation ~33% on an M3 Ultra, while resampling
at the same length saved only ~10%), so keep them short.

The first request after an idle period pays ~45s of model load. KEEP_WARM_VOICE
re-synthesises a short phrase on an interval to hold the model resident, so the
voice you use most never pays that cost.
"""
import base64
import io
import logging
import os
import threading
import time
import wave

import requests
from flask import Flask, Response, jsonify, request

RAPID_MLX_URL = os.getenv("RAPID_MLX_URL", "http://127.0.0.1:8890")
TTS_MODEL = os.getenv("TTS_MODEL", "chatterbox")
VOICES_DIR = os.getenv(
    "VOICES_DIR",
    os.path.expanduser("~/Library/Application Support/Choom/voices-prepared"),
)
PORT = int(os.getenv("PORT", "8004"))
BIND = os.getenv("BIND", "0.0.0.0")
DEFAULT_VOICE = os.getenv("DEFAULT_VOICE", "sophie")

# Genesis is the most-used Choom; hold her voice resident so she never pays the
# cold-load penalty. Set to "" to disable.
KEEP_WARM_VOICE = os.getenv("KEEP_WARM_VOICE", DEFAULT_VOICE)
KEEP_WARM_INTERVAL = int(os.getenv("KEEP_WARM_INTERVAL", "240"))
REQUEST_TIMEOUT = int(os.getenv("REQUEST_TIMEOUT", "300"))

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"),
                    format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger("tts-bridge")

app = Flask(__name__)
_last_synth = 0.0
_lock = threading.Lock()


def voice_path(name: str):
    wav = os.path.join(VOICES_DIR, f"{name}.wav")
    txt = os.path.join(VOICES_DIR, f"{name}.txt")
    return (wav, txt) if os.path.isfile(wav) and os.path.isfile(txt) else (None, None)


def list_voices():
    if not os.path.isdir(VOICES_DIR):
        return []
    return sorted(
        f[:-4] for f in os.listdir(VOICES_DIR)
        if f.endswith(".wav") and os.path.isfile(os.path.join(VOICES_DIR, f[:-4] + ".txt"))
    )


def synthesize(text: str, voice: str) -> bytes:
    wav, txt = voice_path(voice)
    if not wav:
        raise KeyError(voice)
    with open(wav, "rb") as fh:
        ref_audio = base64.b64encode(fh.read()).decode()
    with open(txt, "r", encoding="utf-8") as fh:
        ref_text = fh.read().strip()

    r = requests.post(
        f"{RAPID_MLX_URL}/v1/audio/speech",
        json={
            "model": TTS_MODEL,
            "input": text,
            "voice": "default",
            "ref_audio": ref_audio,
            "ref_text": ref_text,
            "response_format": "wav",
        },
        timeout=REQUEST_TIMEOUT,
    )
    r.raise_for_status()
    global _last_synth
    _last_synth = time.time()
    return r.content


@app.get("/v1/voices")
def voices():
    return jsonify({"voices": list_voices()})


@app.get("/v1/info")
def info():
    return jsonify({
        "name": "Choom TTS Bridge (Rapid-MLX / chatterbox)",
        "version": "1.0.0",
        "sample_rate": 24000,
        "model": TTS_MODEL,
        "upstream": RAPID_MLX_URL,
        "keep_warm": KEEP_WARM_VOICE or None,
        "voices": [{"name": v, "path": os.path.join(VOICES_DIR, f"{v}.wav")}
                   for v in list_voices()],
    })


@app.get("/health")
def health():
    try:
        requests.get(f"{RAPID_MLX_URL}/v1/models", timeout=5).raise_for_status()
        upstream = "ok"
    except Exception as e:  # noqa: BLE001
        upstream = f"unreachable: {e}"
    return jsonify({"status": "ok", "upstream": upstream,
                    "voices": len(list_voices()),
                    "seconds_since_synth": round(time.time() - _last_synth, 1) if _last_synth else None})


@app.post("/v1/audio/speech")
def speech():
    body = request.get_json(silent=True) or {}
    text = (body.get("input") or "").strip()
    voice = body.get("voice") or DEFAULT_VOICE
    if not text:
        return jsonify({"error": "input is required"}), 400
    try:
        audio = synthesize(text, voice)
    except KeyError:
        return jsonify({"error": f"unknown voice {voice!r}",
                        "voices": list_voices()}), 400
    except Exception as e:  # noqa: BLE001
        logger.error("synthesis failed for voice=%s: %s", voice, e)
        return jsonify({"error": str(e)}), 502
    return Response(audio, mimetype="audio/wav")


def keep_warm():
    """Hold the model resident so the busiest voice never pays the cold load."""
    while True:
        time.sleep(KEEP_WARM_INTERVAL)
        if time.time() - _last_synth < KEEP_WARM_INTERVAL:
            continue  # real traffic already kept it warm
        try:
            with _lock:
                synthesize("Still here.", KEEP_WARM_VOICE)
            logger.info("keep-warm ping (%s)", KEEP_WARM_VOICE)
        except Exception as e:  # noqa: BLE001
            logger.warning("keep-warm failed: %s", e)


if __name__ == "__main__":
    logger.info("voices dir : %s (%d voices)", VOICES_DIR, len(list_voices()))
    logger.info("upstream   : %s (%s)", RAPID_MLX_URL, TTS_MODEL)
    logger.info("keep-warm  : %s every %ss", KEEP_WARM_VOICE or "disabled", KEEP_WARM_INTERVAL)
    if KEEP_WARM_VOICE:
        threading.Thread(target=keep_warm, daemon=True).start()
    app.run(host=BIND, port=PORT, threaded=True)
