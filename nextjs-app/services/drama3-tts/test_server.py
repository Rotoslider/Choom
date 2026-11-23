"""The runaway guard. venv/bin/python -m unittest test_server  (from services/drama3-tts)"""
import unittest

import server


class Budget(unittest.TestCase):
    def test_cues_do_not_count(self):
        self.assertEqual(server.spoken_length("[warm] Hi there."), len("Hi there."))

    def test_budget_fits_normal_speech_not_a_loop(self):
        line = "x" * 114  # the line that looped on Nov 22: ~8 s of words, ran 21.7 s
        frames = server.frame_budget(line)
        self.assertGreater(frames / 21.5, 114 / 14 * 1.2)  # normal takes ran up to ~1.2x
        self.assertLess(frames / 21.5, 14)

    def test_short_lines_keep_room_for_a_laugh(self):
        self.assertGreaterEqual(server.frame_budget("[small laugh] Hi.") / 21.5, 3.5)

    def test_too_long(self):
        line = "x" * 114
        self.assertFalse(server.too_long(9.6, line))   # a normal slow take
        self.assertTrue(server.too_long(21.7, line))   # the loop


if __name__ == "__main__":
    unittest.main()
