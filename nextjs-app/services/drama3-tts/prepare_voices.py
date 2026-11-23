#!/usr/bin/env python3
"""
Reference clips for the Drama 3 voice server, from the original voice recordings.

For each <name>.wav in --src: mono at the recording's own rate (Drama 3 copies a
reference's bandwidth, so 44.1 kHz or more sounds clearer than the 24 kHz cuts
Chatterbox uses), cut to at most --max-seconds at a quiet moment, peak-limited,
and transcribed with Whisper through the Mac's STT server (an OpenAI-style
/v1/audio/transcriptions). Writes <name>.wav + <name>.txt to --out.

    venv/bin/python prepare_voices.py --src "/Volumes/sharedfiles/AI/ai_apps/quite_chatter/voices"

Read each .txt afterwards: the transcript must match the clip word for word,
or the voice comes out wrong. Re-run with --names to redo some.
"""
import argparse
import io
import json
import os
import urllib.request
import uuid

import numpy as np
import soundfile as sf


def quiet_cut(x: np.ndarray, sr: int, max_s: float) -> np.ndarray:
    """At most max_s seconds, cut at the quietest 50 ms of the last 6 s before it."""
    if len(x) <= max_s * sr:
        return x
    win = int(0.05 * sr)
    lo, hi = int((max_s - 6) * sr), int(max_s * sr)
    seg = x[lo:hi]
    n = len(seg) // win
    energy = (seg[: n * win].reshape(n, win) ** 2).mean(axis=1)
    return x[: lo + int(np.argmin(energy)) * win + win // 2]


def transcribe(wav_bytes: bytes, stt: str) -> str:
    b = uuid.uuid4().hex
    body = (f"--{b}\r\nContent-Disposition: form-data; name=\"response_format\"\r\n\r\njson\r\n"
            f"--{b}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.wav\"\r\n"
            f"Content-Type: audio/wav\r\n\r\n").encode() + wav_bytes + f"\r\n--{b}--\r\n".encode()
    req = urllib.request.Request(f"{stt}/v1/audio/transcriptions", data=body,
                                 headers={"Content-Type": f"multipart/form-data; boundary={b}"})
    return json.loads(urllib.request.urlopen(req, timeout=300).read())["text"].strip()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", required=True, help="folder of original <name>.wav recordings")
    ap.add_argument("--out", default=os.path.expanduser("~/Library/Application Support/Choom/voices-drama3"))
    ap.add_argument("--names", nargs="*", help="only these voices (default: every .wav in --src)")
    ap.add_argument("--max-seconds", type=float, default=25.0)
    ap.add_argument("--stt", default=os.getenv("STT_ENDPOINT", "http://127.0.0.1:8890"))
    a = ap.parse_args()

    os.makedirs(a.out, exist_ok=True)
    names = a.names or sorted(f[:-4] for f in os.listdir(a.src) if f.lower().endswith(".wav"))
    for name in names:
        x, sr = sf.read(os.path.join(a.src, f"{name}.wav"), dtype="float32", always_2d=True)
        x = quiet_cut(x.mean(axis=1), sr, a.max_seconds)
        peak = float(np.abs(x).max()) or 1.0
        x = x * min(1.0, 0.89 / peak)
        sf.write(os.path.join(a.out, f"{name}.wav"), x, sr, subtype="PCM_16")
        buf = io.BytesIO()
        sf.write(buf, x, sr, subtype="PCM_16", format="WAV")
        text = transcribe(buf.getvalue(), a.stt)
        with open(os.path.join(a.out, f"{name}.txt"), "w", encoding="utf-8") as fh:
            fh.write(text + "\n")
        print(f"{name:24s} {sr:6d} Hz {len(x) / sr:5.1f} s  {text[:90]}", flush=True)


if __name__ == "__main__":
    main()
