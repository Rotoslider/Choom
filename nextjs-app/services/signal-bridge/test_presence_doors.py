"""The wake note says which doors were opened in the last hour and whether he could have gone
through (2026-10-28): only a door and its screen open together let him through, so a door left open
for the night with its screen shut (the north door in summer) says nothing.
Run: venv/bin/python -m unittest test_presence_doors -v
"""
import unittest
from datetime import datetime, timedelta, timezone

from presence_heartbeat import _doors_line

NOW = datetime(2026, 10, 28, 8, 20, tzinfo=timezone.utc)  # 2:20 AM MDT
START = NOW - timedelta(hours=1)
DOORS = [{"name": "east door", "door": "e", "screen": "es", "leads": "outside"},
         {"name": "north door", "door": "n", "screen": "ns"},
         {"name": "shop door", "door": "s"}]


def at(minute):  # minutes into the hour, from 1:20 AM MDT
    return START + timedelta(minutes=minute)


def history(**sensors):
    """Each sensor: its state at the window's start, then (minute, state) changes."""
    base = {"e": ["off"], "es": ["on"], "n": ["off"], "ns": ["off"], "s": ["off"]}
    base.update(sensors)
    return {eid: [(START, seq[0])] + [(at(m), s) for m, s in seq[1:]] for eid, seq in base.items()}


class Doors(unittest.TestCase):
    def test_nothing_opened_says_nothing(self):
        self.assertEqual(_doors_line(history(), DOORS, NOW), "")

    def test_north_door_open_all_night_screen_shut_says_nothing(self):
        self.assertEqual(_doors_line(history(n=["on"], ns=["off"]), DOORS, NOW), "")

    def test_east_door_opened_with_its_screen_rolled_back(self):
        line = _doors_line(history(e=["off", (54, "on"), (60, "off")]), DOORS, NOW)
        self.assertEqual(line, "Doors in the last hour — East door (leads outside): door opened 2:14 AM (6 min ago), "
                               "door closed 2:20 AM (just now). Door and screen were open together, so he may have "
                               "gone through. Now: door closed, screen open.")

    def test_door_opened_for_air_with_the_screen_shut(self):
        line = _doors_line(history(n=["off", (30, "on")]), DOORS, NOW)
        self.assertIn("North door: door opened 1:50 AM (30 min ago). Door and screen were never open together, "
                      "so nobody went through. Now: door open, screen closed.", line)

    def test_screen_opened_while_the_door_stood_open(self):
        line = _doors_line(history(e=["on"], es=["off", (50, "on"), (51, "off")]), DOORS, NOW)
        self.assertIn("screen opened 2:10 AM (10 min ago), screen closed 2:11 AM (9 min ago). Door and screen "
                      "were open together", line)

    def test_door_without_a_screen(self):
        self.assertIn("Shop door: door opened 1:30 AM (50 min ago). He may have gone through. Now: door open.",
                      _doors_line(history(s=["off", (10, "on")]), DOORS, NOW))

    def test_a_restart_is_not_an_opening(self):
        self.assertEqual(_doors_line(history(n=["on", (5, "unavailable"), (5, "on")]), DOORS, NOW), "")


if __name__ == "__main__":
    unittest.main()
