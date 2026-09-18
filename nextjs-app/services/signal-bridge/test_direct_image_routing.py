"""parse_direct_message (2026-09-18): a 1:1 Signal photo with an "Aloy, …"
caption must route to Aloy. The image note used to be prepended before the
name parser ran, so the name was never seen and the photo went to the
last-used Choom (Genesis).
Run: venv/bin/python -m unittest test_direct_image_routing -v"""
import unittest
from unittest.mock import patch
from bridge import parse_direct_message, image_context_note

IMG = "uploads/signal_20260918_140036_cofwBdzr.jpg"
CAPTION = ("Aloy, the middle m3 face plate came off and looks good. I mocked it up "
           "in front of the m3 with it and the bottom plate and took a picture so you could see it.")


def fake_match(name):
    return {"aloy": "Aloy", "genesis": "Genesis", "eve": "Eve"}.get(name.strip().lower())


class DirectImageRouting(unittest.TestCase):
    def setUp(self):
        p = patch("signal_handler.MessageParser._match_choom_name", side_effect=fake_match)
        p.start(); self.addCleanup(p.stop)

    def test_addressed_caption_with_photo_routes_to_that_choom(self):
        name, text = parse_direct_message(CAPTION, [IMG])
        self.assertEqual(name, "Aloy")
        self.assertTrue(text.startswith(f"[User attached image: {IMG}]"))
        self.assertIn(f'image_path="{IMG}"', text)
        self.assertTrue(text.endswith("so you could see it."))
        self.assertNotIn("Aloy,", text)

    def test_photo_without_caption_has_no_name(self):
        name, text = parse_direct_message("", [IMG])
        self.assertIsNone(name)
        self.assertEqual(text, image_context_note([IMG]))

    def test_caption_without_photo_is_unchanged(self):
        self.assertEqual(parse_direct_message("Eve: hi", []), ("Eve", "hi"))
        self.assertEqual(parse_direct_message("hello there", []), (None, "hello there"))

    def test_two_photos_one_note_per_image(self):
        name, text = parse_direct_message("genesis, compare these", ["a.jpg", "b.jpg"])
        self.assertEqual(name, "Genesis")
        self.assertEqual(text.count("[User attached image:"), 2)
        self.assertTrue(text.endswith("compare these"))


if __name__ == "__main__":
    unittest.main()
