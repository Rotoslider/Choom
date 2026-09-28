"""What reaches Signal and TTS after a looping wake-up (2026-09-28, Eve).

1. The server cuts a loop out of text it already streamed (retract_partial)
   and saves a cleaned reply (done). The bridge ignored the retraction and
   took the done copy only when it was LONGER — so every server-side cleanup
   (loop strip, dropped narration preambles) was undone on Signal.
2. Wake-up voice notes went through the scheduler's own weaker TTS cleanup,
   which spoke HTML and URLs aloud.

Run: venv/bin/python -m unittest test_delivered_text -v
"""
import json
import unittest
from unittest import mock

from choom_client import ChoomClient, ChoomInfo
from tts_text import strip_markup_for_tts


def _sse(events):
    return [f"data: {json.dumps(e)}".encode() for e in events]


class DeliveredReply(unittest.TestCase):
    def _send(self, events):
        client = ChoomClient(base_url="http://choom.test")
        eve = ChoomInfo(id="c1", name="Eve", description=None, voice_id=None, companion_id=None)
        resp = mock.Mock()
        resp.iter_lines.return_value = _sse(events)
        with mock.patch.object(client, "get_choom_by_name", return_value=eve), \
             mock.patch.object(client, "get_or_create_autonomous_chat", return_value="chat1"), \
             mock.patch.object(client, "_build_shared_settings", return_value={"llm": {}}), \
             mock.patch.object(client, "_make_request", return_value=resp):
            return client.send_message("Eve", "wake up", fresh_chat=True, is_heartbeat=True).content

    def test_retract_partial_drops_the_streamed_loop(self):
        good = "The sunrise frame is on its way, love."
        loop = "\n\n*Always.*\n\n*Forever.*"
        got = self._send([
            {"type": "content", "content": good + loop},
            {"type": "retract_partial", "length": len(loop)},
        ])
        self.assertEqual(got, good)

    def test_shorter_done_content_wins(self):
        streamed = "Good morning, world. Let me ground myself first.\n\nThe sunrise frame is on its way, love."
        saved = "The sunrise frame is on its way, love."
        got = self._send([
            {"type": "content", "content": streamed},
            {"type": "done", "content": saved},
        ])
        self.assertEqual(got, saved)

    def test_empty_done_content_keeps_the_stream(self):
        got = self._send([
            {"type": "content", "content": "Here you go, love."},
            {"type": "done", "content": ""},
        ])
        self.assertEqual(got, "Here you go, love.")


class TtsMarkup(unittest.TestCase):
    def test_invented_buttons_and_tags_are_not_spoken(self):
        text = (
            "*I checked the weather for you, too.*\n\n"
            "<button onclick=\"window.location.href='https://www.google.com/search?q=weather+in+heaven'\">"
            "Search Weather in Heaven</button>\n\n<hr>\n\n*Always.*"
        )
        self.assertEqual(strip_markup_for_tts(text), "I checked the weather for you, too. Always.")

    def test_image_alt_text_is_not_spoken(self):
        text = "Look at this one. ![A breathtaking desert sunrise, soft peach sky](tower_cam/images/sunrise.png) Isn't it lovely?"
        self.assertEqual(strip_markup_for_tts(text), "Look at this one. Isn't it lovely?")

    def test_links_keep_text_and_bare_urls_go(self):
        text = "See [Aloy's letter](choom_commons/for_eve/letter.md) and https://weather.com/today ❤️"
        self.assertEqual(strip_markup_for_tts(text), "See Aloy's letter and")

    def test_plain_prose_and_less_than_signs_survive(self):
        text = "It's 78°F — warmer than yesterday, and wind < 10 mph. I love you <3"
        self.assertEqual(strip_markup_for_tts(text), text)


if __name__ == "__main__":
    unittest.main()
