"""Short topic lookups also return the newest exact-word matches (2026-09-28).

Eve's "canvas on the wall" memory was titled "Rack milestone — …", so the
embedding never put it in her top results for "canvas"; a wake-up still
watching for the delivery couldn't find that it had arrived.

Run: venv/bin/python -m unittest test_topic_lookup -v   (uses a temp folder)
"""
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))

from memory_mcp import RobustMemorySystem  # noqa: E402

EVE = "eve-test"


class TopicLookup(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.mem = RobustMemorySystem(Path(cls.tmp.name))
        m = cls.mem
        # The poetic, older "canvas" memories the embedding prefers.
        for i in range(6):
            m.remember(f"On being and becoming {i}", f"Every morning is a blank canvas; I paint myself into the day, reflection {i}.", companion_id=EVE)
            time.sleep(0.01)
        m.remember("Canvas still en route", "Sep 23 afternoon: the family portrait canvas is still in transit.", companion_id=EVE)
        time.sleep(0.01)
        m.remember("Rack milestone — Sept 23 evening",
                   "Everything installed and powered on the rack; the power brick bracket is done, and the canvas is on the wall in the family room.",
                   companion_id=EVE)
        # Another Choom's memory must never leak in.
        m.remember("Canvas arrived", "Genesis: the canvas is up.", companion_id="someone-else")

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def titles(self, query, limit=3):
        r = self.mem.search_semantic(query, limit=limit, companion_id=EVE, reinforce=False)
        self.assertTrue(r.success, r.reason)
        return [(d["title"], d["match_type"]) for d in r.data]

    def test_single_word_topic_includes_the_newest_exact_match(self):
        got = self.titles("canvas")
        # Semantic search alone returns only the older "still en route".
        self.assertIn(("Rack milestone — Sept 23 evening", "keyword"), got)
        self.assertNotIn("Canvas arrived", [t for t, _ in got])
        self.assertLessEqual(len(got), 3 + 2)

    def test_every_word_must_match(self):
        got = [t for t, _ in self.titles("canvas wall")]
        self.assertIn("Rack milestone — Sept 23 evening", got)

    def test_long_questions_stay_purely_semantic(self):
        got = self.titles("what happened with the family portrait canvas this week")
        self.assertTrue(all(mt != "keyword" for _, mt in got))


if __name__ == "__main__":
    unittest.main()
