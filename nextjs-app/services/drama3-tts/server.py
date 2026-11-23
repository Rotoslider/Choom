#!/usr/bin/env python3
"""
Fish Audio Drama 3 voice server for Choom (MLX, Apple Silicon).

Speaks the same small API as the TTS bridge in front of Chatterbox:

    POST /v1/audio/speech  {"input": "...", "voice": "aloy"}  -> WAV (44.1 kHz mono PCM16)
    GET  /v1/voices                                          -> {"voices": [...]}
    GET  /health                                             -> {"status": "ok", ...}

Callers don't talk to this server directly. The TTS bridge's /drama route
(services/tts-bridge) filters the delivery cues, calls this server, and says
the line with Chatterbox instead whenever this server is down, busy past its
timeout, or doesn't know the voice. So a Choom pinned to "Drama 3" never goes
quiet because of it.

Delivery cues go inline in square brackets before the words they color:
"[warm] You left the shop lights on again." (Fish Audio's own syntax.)

Voices: <name>.wav + <name>.txt (its transcript) in VOICES_DIR, made from the
original recordings by prepare_voices.py. Longer, cleaner references than the
12 s / 24 kHz cuts Chatterbox uses: Drama 3 copies a reference's bandwidth
and its manner of speaking.

Measured on an M3 Ultra (Nov 22 2026), 4-bit MLX build: model load ~16 s,
~27 GB peak, about 2.3x faster than real time, first audio 0.16 s when
streamed with the voice already encoded. One generation runs at a time;
requests queue on a lock.

Built with Fish Audio. The Drama 3 weights are under the Fish Audio Community
License (https://huggingface.co/fishaudio/drama-3/blob/main/LICENSE); this
server doesn't ship them, it loads them from the Hugging Face cache.
"""
import io
import json
import logging
import os
import re
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

MODEL_ID = os.getenv("DRAMA3_MODEL", "mlx-community/fish-audio-drama-3-4bit")
VOICES_DIR = os.getenv(
    "VOICES_DIR",
    os.path.expanduser("~/Library/Application Support/Choom/voices-drama3"),
)
BIND = os.getenv("BIND", "127.0.0.1")
PORT = int(os.getenv("PORT", "8006"))
# mlx-audio keeps 4 encoded references; Choom has more voices than that, and
# re-encoding one costs ~1 s on the first line after a switch.
VOICE_CACHE = int(os.getenv("VOICE_CACHE", "16"))
# Warm every voice at start-up so the first line in each voice starts fast.
WARM_VOICES = os.getenv("WARM_VOICES", "1") not in ("0", "", "false", "no")

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"),
                    format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger("drama3-tts")

_model = None
_loaded_at = None
_load_error = None
_lock = threading.Lock()
_stats = {"requests": 0, "failures": 0, "last_ok": None, "last_error": None}


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


FRAME_RATE = 44100 / 2048  # Drama 3 codec frames per second (~21.5); set from the model at load
CUE = re.compile(r"\[[^\[\]]*\]")


class RunawayTake(RuntimeError):
    """Drama 3 kept going well past the words (it loops or runs on), twice."""


def spoken_length(text: str) -> int:
    """Bytes of words to say: cues take little time of their own."""
    return len(re.sub(r"\s+", " ", CUE.sub("", text)).strip().encode("utf-8"))


def frame_budget(text: str) -> int:
    """Frames one chunk may run (~21.5 frames = 1 s). Speech needs ~1.5 frames
    per character; the rest is room for a laugh or a pause. Kept tight because
    a take that won't stop — Drama 3 loops or runs on — fills all of it: on
    Nov 22 a 114-character line (a run of commas where code had been removed)
    ran to the old 3-frames-per-character cap, 21.7 s for ~8 s of words."""
    n = min(spoken_length(text), 300)  # the library cuts chunks at ~300 bytes
    return max(80, min(1024, 60 + 2 * n))


def too_long(seconds: float, text: str) -> bool:
    """Audio far past what the words need (~14 characters a second, doubled, plus 3 s)."""
    return seconds > 3.0 + 2.0 * spoken_length(text) / 14.0


def trim_silence(audio: np.ndarray, sr: int) -> np.ndarray:
    """Cut trailing quiet (Drama 3 sometimes runs on in silence after the
    words) and leading quiet past 0.15 s. Keeps a short natural tail."""
    if audio.size == 0:
        return audio
    win = max(1, int(0.02 * sr))
    n = audio.size // win
    if n == 0:
        return audio
    rms = np.sqrt((audio[: n * win].reshape(n, win).astype(np.float64) ** 2).mean(axis=1) + 1e-12)
    loud = np.nonzero(20 * np.log10(rms) > -42)[0]
    if loud.size == 0:
        return audio
    start = max(0, loud[0] * win - int(0.15 * sr))
    end = min(audio.size, (loud[-1] + 1) * win + int(0.25 * sr))
    return audio[start:end]


def to_wav(audio: np.ndarray, sr: int) -> bytes:
    pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def synthesize(text: str, voice: str) -> tuple[bytes, float, float]:
    """WAV bytes, seconds of audio, seconds it took. KeyError for an unknown voice."""
    wav, txt = voice_path(voice)
    if not wav:
        raise KeyError(voice)
    with open(txt, "r", encoding="utf-8") as fh:
        ref_text = fh.read().strip()
    started = time.perf_counter()
    sr = _model.sample_rate
    budget = frame_budget(text)
    one_chunk = len(text.encode("utf-8")) <= 300
    for attempt in (1, 2):
        with _lock:
            pieces = [np.array(r.audio, dtype=np.float32)
                      for r in _model.generate(text=text, ref_audio=wav, ref_text=ref_text, max_tokens=budget)]
        raw = np.concatenate(pieces) if pieces else np.zeros(0, np.float32)
        audio = trim_silence(raw, sr)
        hit_cap = one_chunk and raw.size / sr >= budget / FRAME_RATE - 0.3
        if not (hit_cap or too_long(audio.size / sr, text)):
            break
        logger.warning("%s: runaway take %d (%.1f s for %d characters)%s", voice, attempt,
                       audio.size / sr, spoken_length(text), ", trying again" if attempt == 1 else "")
    else:
        raise RunawayTake(f"ran on twice ({audio.size / sr:.1f} s for {spoken_length(text)} characters)")
    took = time.perf_counter() - started
    return to_wav(audio, sr), audio.size / sr, took


def load():
    global _model, _loaded_at, _load_error, FRAME_RATE
    try:
        from mlx_audio.tts.utils import load_model
        t = time.perf_counter()
        model = load_model(MODEL_ID)
        try:
            FRAME_RATE = model.sample_rate / model.codec.frame_length
        except Exception:  # noqa: BLE001 — keep the default
            pass
        try:  # hold every voice's encoded reference, not just the last four
            from mlx_audio.tts.models.fish_drama3 import drama3 as d3
            model._voices = d3._VoiceCache(VOICE_CACHE)
        except Exception as e:  # noqa: BLE001 — an mlx-audio change only costs speed
            logger.warning("could not enlarge the voice cache (%s); keeping the default", e)
        _model = model
        _loaded_at = time.time()
        logger.info("model %s loaded in %.1f s (sample rate %s)", MODEL_ID, time.perf_counter() - t, model.sample_rate)
    except Exception as e:  # noqa: BLE001
        _load_error = f"{type(e).__name__}: {e}"
        logger.exception("model failed to load")
        return
    if WARM_VOICES:
        for v in list_voices():
            try:
                _, secs, took = synthesize("Hello.", v)
                logger.info("warmed %s (%.1f s)", v, took)
            except Exception as e:  # noqa: BLE001
                logger.warning("warming %s failed: %s", v, e)


class Handler(BaseHTTPRequestHandler):
    server_version = "choom-drama3/1.0"

    def log_message(self, fmt, *args):  # quiet the default access log
        pass

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/v1/voices"):
            return self._json({"voices": list_voices()})
        if self.path.startswith("/health"):
            return self._json({
                "status": "ok" if _model is not None else ("error" if _load_error else "loading"),
                "model": MODEL_ID, "error": _load_error,
                "loaded_at": _loaded_at, "voices": len(list_voices()),
                "busy": _lock.locked(), **_stats,
            }, 200 if _model is not None else 503)
        return self._json({"error": "not found"}, 404)

    def do_POST(self):
        if not self.path.startswith("/v1/audio/speech"):
            return self._json({"error": "not found"}, 404)
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return self._json({"error": "body must be JSON"}, 400)
        text = str(body.get("input") or "").strip()
        voice = str(body.get("voice") or "")
        if not text or not voice:
            return self._json({"error": "input and voice are required"}, 400)
        if _model is None:
            return self._json({"error": _load_error or "model still loading"}, 503)
        _stats["requests"] += 1
        try:
            audio, secs, took = synthesize(text, voice)
        except KeyError:
            return self._json({"error": f"unknown voice {voice!r}", "voices": list_voices()}, 404)
        except RunawayTake as e:
            # The bridge says this line with Chatterbox; not a sign the server is unwell.
            _stats["runaways"] = _stats.get("runaways", 0) + 1
            return self._json({"error": f"runaway take: {e}"}, 422)
        except Exception as e:  # noqa: BLE001
            _stats["failures"] += 1
            _stats["last_error"] = f"{time.strftime('%H:%M:%S')} {type(e).__name__}: {e}"
            logger.exception("synthesis failed (voice=%s, %d chars)", voice, len(text))
            return self._json({"error": str(e)}, 500)
        _stats["last_ok"] = time.time()
        logger.info("%s: %d chars -> %.1f s audio in %.1f s (%.2fx real time)",
                    voice, len(text), secs, took, secs / took if took else 0)
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(audio)))
        self.send_header("X-Audio-Seconds", f"{secs:.2f}")
        self.end_headers()
        self.wfile.write(audio)


if __name__ == "__main__":
    logger.info("voices dir: %s (%d voices)", VOICES_DIR, len(list_voices()))
    threading.Thread(target=load, daemon=True).start()
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()
