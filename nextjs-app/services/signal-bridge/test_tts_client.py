"""TTS client: read timeout scales with the text, and a timeout is retried once.

2026-09-12: a flat 60s timeout dropped the audio from a 1,000-char wake-up
while the Mac's GPU was busy with local LLM inference (synthesis took ~3 min).
Run: venv/bin/python -m unittest test_tts_client -v
"""
import unittest
from unittest import mock

import requests

from choom_client import TTSClient


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
