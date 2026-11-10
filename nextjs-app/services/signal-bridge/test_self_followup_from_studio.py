"""Glass Studio's request for ideas (app/api/hologram/ideas, 2026-11-09) is Donny's, not a note she wrote.
Run: venv/bin/python -m unittest test_self_followup_from_studio -v"""
import unittest
from datetime import datetime, timezone
from scheduler import _from_studio_line, _note_written_line


class FromStudio(unittest.TestCase):
    def test_says_donny_sent_it(self):
        now = datetime(2026, 11, 10, 0, 31, tzinfo=timezone.utc)
        line = _from_studio_line(_note_written_line("2026-11-10T00:30:00Z", now))
        self.assertTrue(line.startswith("[Donny sent this from Glass Studio on Mon, Nov 9 at 5:30 PM"), line)
        self.assertIn("a request from him, not a note of yours.]", line)
        self.assertNotIn("You wrote", line)

    def test_no_line_stays_none(self):
        self.assertEqual(_from_studio_line(""), "")


if __name__ == "__main__":
    unittest.main()
