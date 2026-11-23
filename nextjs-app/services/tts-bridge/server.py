#!/usr/bin/env python3
"""
Chatterbox-compatible TTS shim in front of a Rapid-MLX server.

Choom (and Home Assistant) already speak the QUITE_CHATTER API:

    POST /v1/audio/speech  {"input": "...", "voice": "sophie", "speed": 1.1}  -> WAV
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

Drama 3 (Nov 2026). The same API under /drama:

    POST /drama/v1/audio/speech   -> Drama 3 (services/drama3-tts, DRAMA3_URL),
                                     or Chatterbox when Drama 3 fails
    GET  /drama/v1/voices         -> the same voices as /v1/voices
    GET  /drama/health

A Choom is pinned to it with Settings' TTS provider "Drama 3"
(endpoint http://localhost:8004/drama). Delivery cues like "[warm]" are
filtered for Drama 3 and removed for Chatterbox (voice_cues.py). If Drama 3
is down, slow past its timeout, or doesn't know the voice, the same line is
said by Chatterbox in the same voice, so a Choom never goes quiet over it;
the X-TTS-Engine response header says which engine spoke.
"""
import base64
import io
import logging
import os
import subprocess
import tempfile
import threading
import time
import wave

import requests
from flask import Flask, Response, jsonify, request

from voice_cues import filter_cues, strip_cues

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

DRAMA3_URL = os.getenv("DRAMA3_URL", "http://127.0.0.1:8006")
# Drama 3 runs ~2x faster than real time; a line of n characters is ~n/15 s
# of speech. Past this it's queued behind a long line or stuck: Chatterbox
# says it instead.
DRAMA3_BASE_TIMEOUT = float(os.getenv("DRAMA3_BASE_TIMEOUT", "8"))
DRAMA3_SECONDS_PER_CHAR = float(os.getenv("DRAMA3_SECONDS_PER_CHAR", "0.06"))
# After this many failures in a row, skip Drama 3 for DRAMA3_REST seconds.
DRAMA3_FAILURES_TO_REST = int(os.getenv("DRAMA3_FAILURES_TO_REST", "3"))
DRAMA3_REST = int(os.getenv("DRAMA3_REST", "60"))

# Cadence. chatterbox-turbo clones its pace from the reference clip, and it
# speaks slower than the older model did. Note the upstream /v1/audio/speech
# API advertises a `speed` field — it is a NO-OP for this model. Measured:
# speed=0.5 and speed=2.0 both yield the same ~5.7s of audio for a fixed
# sentence, and mlx_audio/tts/models/chatterbox/chatterbox.py says outright
# "speed: Ignored (Chatterbox doesn't support speed adjustment)". So the tempo
# is fixed up here instead, with ffmpeg's atempo filter (tempo only — sample
# rate and pitch are untouched).
#
# The live control is Choom's Settings > Audio > Speech Speed, which arrives as
# `speed` in the request body; TTS_SPEED is only the fallback for callers that
# send none. 1.0 disables the retiming entirely — the audio is returned exactly
# as synthesised.
# 1.05-1.15 is the transparent range; past ~1.25 stretching artefacts creep in,
# and at that point re-cutting the reference clip is the better fix (see the
# VOICES_DIR notes in MAC-SETUP.md).


def _parse_speed(raw, source: str = "TTS_SPEED") -> float:
    """Never let a bad value take the service down — it crash-loops under launchd."""
    if raw is None or not str(raw).strip():
        return 1.0  # unset, or an empty value from a rendered plist
    try:
        value = float(raw)
    except (TypeError, ValueError):
        logging.warning("%s=%r is not a number; using 1.0", source, raw)
        return 1.0
    # One atempo instance is only valid over 0.5-2.0, and anything near those
    # ends is unlistenable anyway.
    if not 0.5 <= value <= 2.0:
        clamped = min(2.0, max(0.5, value))
        logging.warning("%s=%s is outside 0.5-2.0; clamping to %s", source, value, clamped)
        return clamped
    return value


TTS_SPEED = _parse_speed(os.getenv("TTS_SPEED", "1.0"))

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"),
                    format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger("tts-bridge")

app = Flask(__name__)
_last_synth = 0.0
_lock = threading.Lock()
_drama = {"failures": 0, "rest_until": 0.0, "last_error": None, "spoke": 0, "fell_back": 0}


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


def apply_speed(audio: bytes, speed: float) -> bytes:
    """Retime the WAV with ffmpeg's atempo. Pitch and sample rate are unchanged.

    Fails OPEN: any problem here (no ffmpeg, a bad filter string, a timeout)
    logs and returns the untouched audio. Cadence is cosmetic — it must never
    be the reason a Choom goes silent.
    """
    if abs(speed - 1.0) < 1e-3:
        return audio

    # Temp files rather than pipes: a WAV header carries a length field, and
    # ffmpeg cannot seek back to fix it up when writing to stdout.
    try:
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "in.wav")
            dst = os.path.join(tmp, "out.wav")
            with open(src, "wb") as fh:
                fh.write(audio)
            proc = subprocess.run(
                ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
                 "-y", "-i", src, "-filter:a", f"atempo={speed:g}", dst],
                capture_output=True, timeout=30,
            )
            if proc.returncode == 0 and os.path.getsize(dst) > 0:
                with open(dst, "rb") as fh:
                    return fh.read()
            logger.warning("atempo failed (rc=%s): %s", proc.returncode,
                           proc.stderr.decode("utf-8", "replace")[:200])
    except Exception as e:  # noqa: BLE001
        logger.warning("atempo unavailable (%s); serving unadjusted audio", e)
    return audio


def synthesize(text: str, voice: str, speed: float = None) -> bytes:
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
    return apply_speed(r.content, TTS_SPEED if speed is None else speed)


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
        "speed": TTS_SPEED,
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
                    "voices": len(list_voices()), "speed": TTS_SPEED,
                    "seconds_since_synth": round(time.time() - _last_synth, 1) if _last_synth else None})


@app.post("/v1/audio/speech")
def speech():
    body = request.get_json(silent=True) or {}
    text = (body.get("input") or "").strip()
    voice = body.get("voice") or DEFAULT_VOICE
    # Choom's Settings > Audio > Speech Speed slider arrives here. An explicit
    # value always wins; TTS_SPEED is only the fallback for callers that send
    # none (Home Assistant, the keep-warm ping).
    speed = _parse_speed(body["speed"], "request speed") if body.get("speed") is not None else TTS_SPEED
    text = strip_cues(text)  # Chatterbox would read "[small laugh]" aloud
    if not text:
        return jsonify({"error": "input is required"}), 400
    try:
        audio = synthesize(text, voice, speed)
    except KeyError:
        return jsonify({"error": f"unknown voice {voice!r}",
                        "voices": list_voices()}), 400
    except Exception as e:  # noqa: BLE001
        logger.error("synthesis failed for voice=%s: %s", voice, e)
        return jsonify({"error": str(e)}), 502
    return Response(audio, mimetype="audio/wav")


def _drama_failed(reason: str, counts: bool = True):
    _drama["last_error"] = f"{time.strftime('%H:%M:%S')} {reason}"
    if not counts:
        return
    _drama["failures"] += 1
    if _drama["failures"] >= DRAMA3_FAILURES_TO_REST:
        _drama["rest_until"] = time.time() + DRAMA3_REST
        _drama["failures"] = 0
        logger.warning("drama3: %d failures in a row, using Chatterbox for %ss",
                       DRAMA3_FAILURES_TO_REST, DRAMA3_REST)


def drama3_audio(text: str, voice: str):
    """WAV from Drama 3, or None (with the reason logged) to fall back."""
    if time.time() < _drama["rest_until"]:
        return None, "resting after failures"
    timeout = DRAMA3_BASE_TIMEOUT + DRAMA3_SECONDS_PER_CHAR * len(text)
    try:
        r = requests.post(f"{DRAMA3_URL}/v1/audio/speech", json={"input": text, "voice": voice},
                          timeout=(2, timeout))
    except requests.exceptions.Timeout:
        _drama_failed(f"no answer in {timeout:.0f}s")
        return None, f"no answer in {timeout:.0f}s"
    except Exception as e:  # noqa: BLE001 — down, refused, reset
        _drama_failed(type(e).__name__)
        return None, f"unreachable ({type(e).__name__})"
    if r.status_code == 200 and r.content[:4] == b"RIFF":
        _drama["failures"] = 0
        return r.content, None
    reason = f"HTTP {r.status_code}: {r.text[:160]}"
    # A voice it hasn't got (404) or one line that ran on (422) is about that
    # line, not a sign the server is unwell: no rest for those.
    _drama_failed(reason, counts=r.status_code not in (404, 422))
    return None, reason


@app.post("/drama/v1/audio/speech")
def drama_speech():
    body = request.get_json(silent=True) or {}
    text = (body.get("input") or "").strip()
    voice = body.get("voice") or DEFAULT_VOICE
    speed = _parse_speed(body["speed"], "request speed") if body.get("speed") is not None else TTS_SPEED
    if not strip_cues(text):
        return jsonify({"error": "input is required"}), 400
    cued, dropped = filter_cues(text)
    if dropped:
        logger.info("drama3: dropped cues %s", dropped)
    started = time.time()
    audio, reason = drama3_audio(cued, voice)
    if audio is not None:
        _drama["spoke"] += 1
        logger.info("drama3 spoke %s: %d chars in %.1fs", voice, len(cued), time.time() - started)
        return Response(apply_speed(audio, speed), mimetype="audio/wav", headers={"X-TTS-Engine": "drama3"})
    _drama["fell_back"] += 1
    logger.warning("drama3 -> chatterbox for %s (%s)", voice, reason)
    try:
        audio = synthesize(strip_cues(text), voice, speed)
    except KeyError:
        return jsonify({"error": f"unknown voice {voice!r}", "voices": list_voices()}), 400
    except Exception as e:  # noqa: BLE001
        logger.error("fallback synthesis failed for voice=%s: %s", voice, e)
        return jsonify({"error": str(e)}), 502
    return Response(audio, mimetype="audio/wav",
                    headers={"X-TTS-Engine": "chatterbox-fallback", "X-TTS-Fallback-Reason": reason[:200]})


@app.get("/drama/v1/voices")
def drama_voices():
    # Every voice works here: one Drama 3 lacks is said by Chatterbox.
    return jsonify({"voices": list_voices()})


@app.get("/drama/health")
def drama_health():
    try:
        r = requests.get(f"{DRAMA3_URL}/health", timeout=3)
        upstream = r.json()
    except Exception as e:  # noqa: BLE001
        upstream = {"status": f"unreachable: {type(e).__name__}"}
    resting = max(0, round(_drama["rest_until"] - time.time()))
    return jsonify({"status": "ok", "drama3": upstream, "fallback": "chatterbox",
                    "resting_seconds": resting, "spoke": _drama["spoke"], "fell_back": _drama["fell_back"],
                    "last_error": _drama["last_error"]})


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
    logger.info("drama3     : %s (falls back to chatterbox)", DRAMA3_URL)
    logger.info("speed      : %s%s", TTS_SPEED,
                "" if abs(TTS_SPEED - 1.0) < 1e-3 else " (atempo retime)")
    if KEEP_WARM_VOICE:
        threading.Thread(target=keep_warm, daemon=True).start()
    app.run(host=BIND, port=PORT, threaded=True)
