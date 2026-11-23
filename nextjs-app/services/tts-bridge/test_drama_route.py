"""The /drama route: Drama 3 when it answers, Chatterbox (cues removed) when it doesn't.
venv/bin/python -m unittest test_drama_route  (from services/tts-bridge)"""
import unittest
from unittest import mock

import requests

import server

WAV = b"RIFF" + b"\0" * 40


class FakeResponse:
    def __init__(self, status=200, content=WAV, text=""):
        self.status_code, self.content, self.text = status, content, text


class DramaRoute(unittest.TestCase):
    def setUp(self):
        server._drama.update({"failures": 0, "rest_until": 0.0, "last_error": None, "spoke": 0, "fell_back": 0})
        self.client = server.app.test_client()
        self.chatter = mock.patch.object(server, "synthesize", return_value=b"RIFFchatter").start()
        mock.patch.object(server, "apply_speed", side_effect=lambda a, s: a).start()
        self.addCleanup(mock.patch.stopall)

    def say(self, text="[warm] Hi there. [sighs] Bye.", voice="aloy"):
        return self.client.post("/drama/v1/audio/speech", json={"input": text, "voice": voice})

    def test_drama_speaks_with_filtered_cues(self):
        post = mock.patch.object(server.requests, "post", return_value=FakeResponse()).start()
        r = self.say()
        self.assertEqual(r.headers["X-TTS-Engine"], "drama3")
        self.assertEqual(r.data, WAV)
        self.assertEqual(post.call_args.kwargs["json"], {"input": "[warm] Hi there. Bye.", "voice": "aloy"})
        self.chatter.assert_not_called()

    def test_down_falls_back_without_cues(self):
        mock.patch.object(server.requests, "post", side_effect=requests.exceptions.ConnectionError()).start()
        r = self.say()
        self.assertEqual(r.headers["X-TTS-Engine"], "chatterbox-fallback")
        self.assertEqual(r.data, b"RIFFchatter")
        self.assertEqual(self.chatter.call_args.args[:2], ("Hi there. Bye.", "aloy"))

    def test_timeout_falls_back(self):
        mock.patch.object(server.requests, "post", side_effect=requests.exceptions.ReadTimeout()).start()
        self.assertEqual(self.say().headers["X-TTS-Engine"], "chatterbox-fallback")

    def test_rests_after_failures(self):
        post = mock.patch.object(server.requests, "post", return_value=FakeResponse(500, b"", "boom")).start()
        for _ in range(server.DRAMA3_FAILURES_TO_REST):
            self.say()
        calls = post.call_count
        self.assertEqual(self.say().headers["X-TTS-Engine"], "chatterbox-fallback")
        self.assertEqual(post.call_count, calls)  # resting: Drama 3 not asked

    def test_unknown_voice_does_not_count_as_failure(self):
        mock.patch.object(server.requests, "post", return_value=FakeResponse(404, b"", "unknown voice")).start()
        for _ in range(server.DRAMA3_FAILURES_TO_REST + 1):
            self.assertEqual(self.say().headers["X-TTS-Engine"], "chatterbox-fallback")
        self.assertEqual(server._drama["rest_until"], 0.0)

    def test_chatterbox_route_strips_cues(self):
        r = self.client.post("/v1/audio/speech", json={"input": "[warm] Hi.", "voice": "aloy"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.chatter.call_args.args[:2], ("Hi.", "aloy"))


if __name__ == "__main__":
    unittest.main()
