"""Delivery cues on Signal: gone from text, and voice notes go to the Choom's own TTS provider."""
import unittest
from unittest import mock

import choom_client
from choom_client import ChoomInfo, tts_client_for
from tts_text import strip_voice_cues


class StripVoiceCues(unittest.TestCase):
    def test_cues_removed(self):
        self.assertEqual(strip_voice_cues("[warm] You left the lights on. [small laugh] Again."),
                         "You left the lights on. Again.")

    def test_name_labels_links_and_markers_kept(self):
        for text in ("[Aloy]\n\nHi", "[PASS]", "See [the docs](https://x.y)", "Footnote [1]", "a [[wiki]] b"):
            self.assertEqual(strip_voice_cues(text), text, text)

    def test_code_left_alone(self):
        text = "Here:\n```py\nx = [a, b, c]\n```\n[softly] done"
        self.assertEqual(strip_voice_cues(text), "Here:\n```py\nx = [a, b, c]\n```\ndone")

    def test_inline_code_and_indentation_kept(self):
        self.assertEqual(strip_voice_cues("use `[a, b, c]` here"), "use `[a, b, c]` here")
        self.assertEqual(strip_voice_cues("- item\n  - [warm] nested"), "- item\n  - nested")

    def test_empty(self):
        self.assertEqual(strip_voice_cues(""), "")


class TTSClientFor(unittest.TestCase):
    def choom(self, provider):
        return ChoomInfo(id="1", name="Aloy", description=None, voice_id="aloy", companion_id=None,
                         tts_provider_id=provider)

    def test_pinned_provider(self):
        cfg = {"ttsProviders": [{"id": "tts_drama3", "endpoint": "http://localhost:8004/drama"}]}
        with mock.patch("task_config.load_config", return_value=cfg):
            self.assertEqual(tts_client_for(self.choom("tts_drama3")).endpoint, "http://localhost:8004/drama")

    def test_no_pin_or_no_choom_uses_global(self):
        self.assertEqual(tts_client_for(self.choom(None)).endpoint, choom_client.config.TTS_ENDPOINT)
        self.assertEqual(tts_client_for(None).endpoint, choom_client.config.TTS_ENDPOINT)


if __name__ == "__main__":
    unittest.main()
