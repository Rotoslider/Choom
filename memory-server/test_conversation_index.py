"""Conversation index: what goes in, who may see it, and staying in step.

Temp databases with the app's real table shapes; tiny stand-in models keep it
fast (the real ones are exercised by bench/run.py).
Run: venv/bin/python -m unittest test_conversation_index -v
"""
import hashlib
import os
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))
from conversation_index import ConversationIndex, chunk_text, fts_query  # noqa: E402

DIM = 64
T0 = 1_790_000_000.0  # Sep 2026


def fake_embed(texts):
    out = np.zeros((len(texts), DIM), dtype=np.float32)
    for i, t in enumerate(texts):
        for w in t.lower().split():
            out[i, int(hashlib.md5(w.strip(".,!?[]·").encode()).hexdigest(), 16) % DIM] += 1
    n = np.linalg.norm(out, axis=1, keepdims=True)
    return out / np.where(n == 0, 1, n)


def fake_rerank(query, texts):
    q = set(query.lower().split())
    return np.array([sum(w.strip(".,!?[]·") in q for w in t.lower().split()) for t in texts], dtype=float)


def make_app_db(path):
    db = sqlite3.connect(path)
    db.executescript("""
        CREATE TABLE Choom (id TEXT PRIMARY KEY, name TEXT, companionId TEXT);
        CREATE TABLE Chat (id TEXT PRIMARY KEY, title TEXT, choomId TEXT, archived BOOLEAN DEFAULT 0);
        CREATE TABLE Message (id TEXT PRIMARY KEY, chatId TEXT, role TEXT, content TEXT, createdAt INTEGER);
        CREATE TABLE GroupRoom (id TEXT PRIMARY KEY, title TEXT, archived BOOLEAN DEFAULT 0);
        CREATE TABLE GroupParticipant (id TEXT PRIMARY KEY, roomId TEXT, choomId TEXT, active BOOLEAN DEFAULT 1);
        CREATE TABLE GroupMessage (id TEXT PRIMARY KEY, roomId TEXT, role TEXT, authorName TEXT, content TEXT, createdAt INTEGER);
        INSERT INTO Choom VALUES ('gen', 'Genesis', 'comp-gen'), ('eve', 'Eve', 'eve');
        INSERT INTO Chat VALUES ('c1', 'Morning chat', 'gen', 0), ('c2', 'Old chat', 'gen', 1),
            ('cw', '[Autonomous] Heartbeats & Briefings', 'gen', 0), ('cd', '[Delegation] check', 'gen', 0),
            ('cs', '[group scratch]', 'gen', 1), ('ce', 'Eve chat', 'eve', 0);
        INSERT INTO GroupRoom VALUES ('r1', 'Family Time', 1), ('r2', 'Eve only', 0);
        INSERT INTO GroupParticipant VALUES ('p1', 'r1', 'gen', 0), ('p2', 'r1', 'eve', 1), ('p3', 'r2', 'eve', 1);
    """)
    msgs = [
        ("m1", "c1", "user", "the canvas is on our wall in the kitchen", T0 + 100),
        ("m2", "c2", "user", "the rack power module showed up today", T0 + 50),        # archived chat
        ("m3", "cw", "assistant", "canvas still due Thursday, watching the driveway", T0 + 200),  # wake-up
        ("m4", "cd", "assistant", "delegated camera report", T0 + 210),
        ("m5", "ce", "user", "Eve private secret about the telescope", T0 + 120),
    ]
    db.executemany("INSERT INTO Message VALUES (?,?,?,?,?)", [(a, b, c, d, int(e * 1000)) for a, b, c, d, e in msgs])
    db.executemany("INSERT INTO GroupMessage VALUES (?,?,?,?,?,?)", [
        ("g1", "r1", "user", "Donny", "we moved camp to Long Park", int((T0 + 300) * 1000)),
        ("g2", "r2", "assistant", "Eve", "telescope night in the Eve only room", int((T0 + 310) * 1000)),
    ])
    db.commit()
    db.close()


def make_memory_db(path):
    db = sqlite3.connect(path)
    db.execute("CREATE TABLE memories (id TEXT PRIMARY KEY, title TEXT, content TEXT, timestamp TEXT, companion_id TEXT)")
    db.executemany("INSERT INTO memories VALUES (?,?,?,?,?)", [
        ("mem1", "Canvas ordered", "the family canvas is on order", "2026-09-17T12:00:00+00:00", "comp-gen"),
        ("mem2", "Eve memory", "telescope plans", "2026-09-18T12:00:00+00:00", "eve"),
    ])
    db.commit()
    db.close()


class ConversationIndexTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        (root / "memory_db").mkdir()
        self.app = root / "dev.db"
        self.mem = root / "memory_db" / "memories.db"
        make_app_db(self.app)
        make_memory_db(self.mem)
        self.ix = ConversationIndex(root, app_db=self.app, embed_fn=fake_embed, rerank_fn=fake_rerank)
        self.ix.reconcile()

    def tearDown(self):
        self.ix.stop()
        self.tmp.cleanup()

    def refs(self, **kw):
        return {r["id"] for r in self.ix.search(kw.pop("q", "canvas wall power module camp telescope"), "gen", k=20, **kw)}

    def test_what_goes_in(self):
        stats = self.ix.stats()["rows"]
        self.assertEqual(stats, {"chat": 3, "room": 2, "memory": 2})  # m1 m2 m5; g1 g2; mem1 mem2
        got = self.refs()
        self.assertIn("m2", got)       # archived chat
        self.assertIn("g1", got)       # archived room
        self.assertNotIn("m3", got)    # wake-up output
        self.assertNotIn("m4", got)    # delegation

    def test_scoping(self):
        got = self.refs(q="telescope secret room night")
        self.assertNotIn("m5", got)    # Eve's private chat
        self.assertNotIn("g2", got)    # a room Genesis was never in
        self.assertNotIn("mem2", got)  # Eve's memory
        eve = {r["id"] for r in self.ix.search("telescope secret room night", "eve", k=20)}
        self.assertTrue({"m5", "g2", "mem2"} <= eve)

    def test_room_turn_never_sees_private_chats(self):
        got = self.refs(room_turn=True)
        self.assertFalse(got & {"m1", "m2"})
        self.assertIn("g1", got)
        self.assertIn("mem1", got)

    def test_as_of_hides_later_items(self):
        self.assertNotIn("g1", self.refs(as_of=T0 + 250))
        self.assertIn("m1", self.refs(as_of=T0 + 250))

    def test_new_rows_are_tailed_and_deletions_reconciled(self):
        db = sqlite3.connect(self.app)
        db.execute("INSERT INTO Message VALUES ('m9','c1','user','fan plates came off the bed',?)", (int(time.time() * 1000),))
        db.execute("DELETE FROM Message WHERE id = 'm2'")
        db.execute("UPDATE GroupMessage SET content = 'we moved camp to Long Park, not Rustler' WHERE id = 'g1'")
        db.commit(); db.close()
        self.assertEqual(self.ix.ingest_once()["chat"], 1)
        self.assertIn("m9", self.refs(q="fan plates"))
        counts = self.ix.reconcile()
        self.assertEqual(counts["deleted"], 1)
        self.assertNotIn("m2", self.refs())
        g1 = [r for r in self.ix.search("rustler", "gen", k=20) if r["id"] == "g1"]
        self.assertIn("not Rustler", g1[0]["text"])

    def test_unchanged_rows_are_not_re_embedded(self):
        self.assertEqual(self.ix.reconcile()["updated"], 0)

    def test_index_survives_restart(self):
        n = self.ix.stats()["vectors"]
        self.ix.stop()
        again = ConversationIndex(Path(self.tmp.name), app_db=self.app, embed_fn=fake_embed, rerank_fn=fake_rerank)
        self.assertEqual(again.stats()["vectors"], n)
        self.assertIn("m1", {r["id"] for r in again.search("canvas wall", "gen", k=5)})
        self.ix = again

    def test_recency_tilt_prefers_the_newer_of_equal_matches(self):
        db = sqlite3.connect(self.app)
        db.executemany("INSERT INTO Message VALUES (?,?,?,?,?)", [
            ("old", "c1", "user", "the huddle is friday", int((T0 + 400) * 1000)),
            ("new", "c1", "user", "the huddle is friday", int((T0 + 400 + 20 * 86400) * 1000)),
        ])
        db.commit(); db.close()
        self.ix.ingest_once()
        top = self.ix.search("huddle friday", "gen", k=1, as_of=T0 + 30 * 86400)
        self.assertEqual(top[0]["id"], "new")


class CurrentConversationTest(ConversationIndexTest):
    """Auto-recall must not hand back the lines already in the prompt."""

    def test_skips_the_on_screen_part_of_this_chat_but_keeps_its_older_part(self):
        # m1 (T0+100) is older than the on-screen window; add one inside it.
        db = sqlite3.connect(self.app)
        db.execute("INSERT INTO Message VALUES ('m8','c1','user','the canvas is on the wall, look',?)", (int((T0 + 500) * 1000),))
        db.commit(); db.close()
        self.ix.ingest_once()
        got = {r["id"] for r in self.ix.search("canvas wall", "gen", k=20, exclude_thread="c1", exclude_since=T0 + 400)}
        self.assertNotIn("m8", got)   # on screen
        self.assertIn("m1", got)      # same chat, scrolled off
        both = {r["id"] for r in self.ix.search("canvas wall", "gen", k=20)}
        self.assertTrue({"m1", "m8"} <= both)

    def test_room_threads_skip_the_same_way(self):
        got = {r["id"] for r in self.ix.search("camp long park", "gen", k=20, exclude_thread="r1", exclude_since=T0 + 250)}
        self.assertNotIn("g1", got)

    def test_threads_are_filled_on_an_index_built_before_they_existed(self):
        with self.ix._lock:
            self.ix._db.execute("UPDATE chunks SET thread = NULL")
            self.ix._db.commit()
        self.assertGreater(self.ix._backfill_threads(), 0)
        threads = dict(self.ix._db.execute("SELECT ref, thread FROM chunks").fetchall())
        self.assertEqual(threads["m1"], "c1")
        self.assertEqual(threads["m2"], "c2")
        self.assertEqual(threads["g1"], "r1")
        self.assertEqual(threads["mem1"], "comp-gen")
        self.assertEqual(self.ix.reconcile()["updated"], 0)  # nothing re-embedded

    def test_min_relevance_drops_weak_matches(self):
        got = self.ix.search("canvas", "gen", k=20, min_relevance=1)
        self.assertTrue(got)
        self.assertTrue(all(r["relevance"] >= 1 for r in got))


class Helpers(unittest.TestCase):
    def test_fts_query_is_quoted_words_only(self):
        self.assertEqual(fts_query('canvas" OR NEAR(x) -- the wall'), '"canvas" OR "or" OR "near" OR "wall"')
        self.assertEqual(fts_query("the a of"), "")

    def test_chunking_keeps_short_text_whole(self):
        self.assertEqual(chunk_text("hello"), ["hello"])
        parts = chunk_text("\n\n".join(["x" * 700] * 4))
        self.assertTrue(all(len(p) <= 1000 for p in parts))
        self.assertEqual(sum(p.count("x") for p in parts), 2800)


if __name__ == "__main__":
    unittest.main()
