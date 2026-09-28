"""A wake-up says how old its note is (2026-09-28).

The canvas landed Sep 23; wake-ups kept watching the driveway for it through
Sep 27 because their notes said "still due" and nothing told them the note
was days old. Run: venv/bin/python -m unittest test_wake_note -v
"""
import unittest
from datetime import datetime, timezone

from scheduler import _note_written_line

NOW = datetime(2026, 9, 25, 15, 37, tzinfo=timezone.utc)  # Fri 9:37 AM MDT


class NoteAge(unittest.TestCase):
    def test_days_old_note(self):
        self.assertEqual(_note_written_line("2026-09-18T03:33:00.000Z", NOW),
                         "[You wrote this note on Thu, Sep 17 at 9:33 PM — 8 days ago.]")

    def test_hours_and_minutes(self):
        self.assertIn("27 hours ago", _note_written_line("2026-09-24T12:25:00Z", NOW))
        self.assertIn("37 minutes ago", _note_written_line("2026-09-25T15:00:00+00:00", NOW))

    def test_missing_or_bad_timestamp_adds_nothing(self):
        self.assertEqual(_note_written_line(None, NOW), "")
        self.assertEqual(_note_written_line("not a time", NOW), "")


if __name__ == "__main__":
    unittest.main()
