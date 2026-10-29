"""TTS client: read timeout scales with the text, and a timeout is retried once.

2026-09-12: a flat 60s timeout dropped the audio from a 1,000-char wake-up
while the Mac's GPU was busy with local LLM inference (synthesis took ~3 min).
Run: venv/bin/python -m unittest test_tts_client -v
"""
import unittest
from unittest import mock

import requests

import io
import math
import os
import tempfile
import wave

from choom_client import TTSClient, compress_voice_note


class TimeoutRule(unittest.TestCase):
    def test_floor_cap_and_slope(self):
        self.assertEqual(TTSClient.timeout_for("hi"), 120)
        self.assertEqual(TTSClient.timeout_for("x" * 600), 200)
        self.assertEqual(TTSClient.timeout_for("x" * 5000), 300)


class RetryOnTimeout(unittest.TestCase):
    def _wav(self):
        r = mock.Mock(status_code=200)
        r.content = b"RIFF" + b"\x00" * 64
        return r

    def test_one_timeout_then_success_returns_audio(self):
        client = TTSClient("http://tts.test")
        calls = []
        def post(url, json, timeout):
            calls.append(timeout)
            if len(calls) == 1:
                raise requests.exceptions.ReadTimeout("slow")
            return self._wav()
        with mock.patch("choom_client.requests.post", side_effect=post):
            out = client.synthesize("a" * 900, voice="sophie")
        self.assertIsNotNone(out)
        self.assertEqual(calls, [300, 300])

    def test_two_timeouts_gives_up_cleanly(self):
        client = TTSClient("http://tts.test")
        with mock.patch("choom_client.requests.post", side_effect=requests.exceptions.ReadTimeout("slow")):
            self.assertIsNone(client.synthesize("short text"))


if __name__ == "__main__":
    unittest.main()


def _tone_wav(seconds=2, rate=24000):
    """A 220 Hz tone as 24 kHz 16-bit mono WAV bytes, like Chatterbox's speech."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"".join(int(8000 * math.sin(2 * math.pi * 220 * i / rate)).to_bytes(2, "little", signed=True)
                               for i in range(seconds * rate)))
    return buf.getvalue()


class VoiceNoteAsAac(unittest.TestCase):
    """Her voice for Signal as .m4a, about an eighth of the WAV (2026-10-28)."""

    def test_the_wav_becomes_a_much_smaller_m4a(self):
        with tempfile.TemporaryDirectory() as d:
            wav = os.path.join(d, "response.wav")
            with open(wav, "wb") as f:
                f.write(_tone_wav())
            sent = compress_voice_note(wav)
            self.assertTrue(sent.endswith(".m4a"))
            self.assertFalse(os.path.exists(wav))
            self.assertLess(os.path.getsize(sent), len(_tone_wav()) / 5)

    def test_without_ffmpeg_the_wav_goes(self):
        with tempfile.TemporaryDirectory() as d:
            wav = os.path.join(d, "response.wav")
            with open(wav, "wb") as f:
                f.write(_tone_wav(1))
            with mock.patch("choom_client._ffmpeg", return_value=None):
                self.assertEqual(compress_voice_note(wav), wav)
            self.assertTrue(os.path.exists(wav))

    def test_synthesize_to_a_file_returns_the_m4a(self):
        r = mock.Mock(status_code=200)
        r.content = _tone_wav(1)
        with tempfile.TemporaryDirectory() as d, mock.patch("choom_client.requests.post", return_value=r):
            out = TTSClient("http://tts.test").synthesize("Hello there.", voice="sophie", output_path=os.path.join(d, "r.wav"))
            self.assertTrue(out and out.endswith(".m4a") and os.path.exists(out))

