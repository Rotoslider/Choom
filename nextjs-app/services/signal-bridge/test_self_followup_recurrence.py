"""Parity with nextjs-app/lib/self-followup-recurrence.ts (2026-09-12).
Run: venv/bin/python -m unittest test_self_followup_recurrence -v"""
import json, os, tempfile, unittest
from datetime import datetime, timezone
from scheduler import ScheduledTaskManager as S

TZ = "America/Denver"

def utc(s): return datetime.fromisoformat(s.replace("Z", "+00:00"))

class NextOccurrence(unittest.TestCase):
    def test_daily(self):
        r = {"rule": "daily", "time": "18:00", "tz": TZ}
        self.assertEqual(S._sf_next_occurrence(r, utc("2026-09-12T16:00:00Z")).astimezone(timezone.utc), utc("2026-09-13T00:00:00Z"))
        self.assertEqual(S._sf_next_occurrence(r, utc("2026-09-13T00:00:00Z")).astimezone(timezone.utc), utc("2026-09-14T00:00:00Z"))

    def test_weekdays(self):
        r = {"rule": "weekdays", "time": "08:30", "tz": TZ}
        n = S._sf_next_occurrence(r, utc("2026-09-12T16:00:00Z"))
        self.assertEqual((n.year, n.month, n.day, n.hour, n.minute, n.strftime("%a")), (2026, 9, 14, 8, 30, "Mon"))

    def test_weekly_across_dst(self):
        r = {"rule": "weekly", "time": "18:00", "day": "fri", "tz": TZ}
        first = S._sf_next_occurrence(r, utc("2026-10-28T16:00:00Z"))
        second = S._sf_next_occurrence(r, first)
        self.assertEqual(first.astimezone(timezone.utc), utc("2026-10-31T00:00:00Z"))   # same as the TS test
        self.assertEqual(second.astimezone(timezone.utc), utc("2026-11-07T01:00:00Z"))
        self.assertEqual((second.hour, second.strftime("%a")), (18, "Fri"))

    def test_monthly(self):
        r = {"rule": "monthly", "time": "09:00", "day_of_month": 31, "tz": TZ}
        n = S._sf_next_occurrence(r, utc("2026-12-28T16:00:00Z"))
        self.assertEqual((n.year, n.month, n.day, n.hour), (2027, 1, 28, 9))

    def test_bad_rule(self):
        self.assertIsNone(S._sf_next_occurrence({"rule": "hourly", "time": "09:00", "tz": TZ}, utc("2026-09-12T16:00:00Z")))


class Requeue(unittest.TestCase):
    def test_writes_next_pending_copy(self):
        with tempfile.TemporaryDirectory() as root:
            mgr = S.__new__(S)  # no __init__: only the file helpers are used
            entry = {"id": "sf_aaaa1111", "choom_id": "c1", "choom_name": "Genesis", "prompt": "Evening reflection",
                     "reason": "ritual", "trigger_at": "2026-09-13T00:00:00Z", "consumed": False, "status": "pending",
                     "repeat": {"rule": "daily", "time": "18:00", "tz": TZ}, "series_id": "series_x", "target": "room", "room_id": "r1"}
            # fired 3 days late (bridge was down): next lands after NOW, not the day after the missed one
            now = utc("2026-09-16T02:00:00Z")
            new_id = mgr._sf_requeue_routine(root, entry, now)
            self.assertTrue(new_id and new_id.startswith("sf_") and new_id != entry["id"])
            files = os.listdir(os.path.join(root, "pending"))
            self.assertEqual(files, [f"{new_id}.json"])
            with open(os.path.join(root, "pending", files[0])) as fh:
                new = json.load(fh)
            self.assertEqual(new["trigger_at"], "2026-09-17T00:00:00Z")
            for k in ("prompt", "reason", "repeat", "series_id", "target", "room_id", "choom_name"):
                self.assertEqual(new[k], entry[k])
            self.assertEqual(new["requeued_from"], "sf_aaaa1111")
            self.assertFalse(new["consumed"]); self.assertEqual(new["status"], "pending")

    def test_not_a_routine(self):
        with tempfile.TemporaryDirectory() as root:
            mgr = S.__new__(S)
            self.assertIsNone(mgr._sf_requeue_routine(root, {"id": "x", "trigger_at": "2026-09-13T00:00:00Z"}, utc("2026-09-13T00:00:00Z")))
            self.assertFalse(os.path.exists(os.path.join(root, "pending")))

if __name__ == "__main__":
    unittest.main()


class FireLoop(unittest.TestCase):
    """The real _check_self_followups against a temp queue root, with only the
    Signal/room delivery stubbed: claim → re-queue → fire → finalize."""

    def _mgr(self, root, ok=True):
        mgr = S.__new__(S)
        mgr._SF_QUEUE_ROOT = root
        mgr.choom = type("C", (), {"is_user_active": staticmethod(lambda *_a, **_k: False)})()
        mgr.fired = []
        def fake_hb(task_id, choom_name, prompt, respect_quiet=False):
            mgr.fired.append({"task_id": task_id, "choom_name": choom_name, "prompt": prompt})
            return ok
        mgr._execute_custom_heartbeat = fake_hb
        mgr._sf_migrate_legacy_jsonl = lambda: None
        mgr._sf_cleanup_old_terminal = lambda: None
        return mgr

    def _seed(self, root, entry):
        d = os.path.join(root, "c1", "pending"); os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, f"{entry['id']}.json"), "w") as fh: json.dump(entry, fh)

    def _bucket(self, root, bucket):
        d = os.path.join(root, "c1", bucket)
        return sorted(os.listdir(d)) if os.path.isdir(d) else []

    def test_routine_fires_and_requeues_once(self):
        with tempfile.TemporaryDirectory() as root:
            mgr = self._mgr(root)
            self._seed(root, {"id": "sf_r1", "choom_id": "c1", "choom_name": "Genesis", "prompt": "Evening reflection", "reason": "",
                              "trigger_at": "2020-01-01T01:00:00Z", "consumed": False, "status": "pending",
                              "repeat": {"rule": "daily", "time": "18:00", "tz": TZ}, "series_id": "series_1"})
            mgr._check_self_followups()
            self.assertEqual(len(mgr.fired), 1)
            self.assertIn("one of your routines (daily at 18:00)", mgr.fired[0]["prompt"])
            self.assertIn("Evening reflection", mgr.fired[0]["prompt"])
            fired = self._bucket(root, "fired"); pend = self._bucket(root, "pending")
            self.assertEqual(fired, ["sf_r1.json"]); self.assertEqual(len(pend), 1)
            with open(os.path.join(root, "c1", "fired", "sf_r1.json")) as fh: old = json.load(fh)
            with open(os.path.join(root, "c1", "pending", pend[0])) as fh: new = json.load(fh)
            self.assertEqual(old["status"], "fired"); self.assertTrue(old["consumed"])
            self.assertEqual(old["requeued_as"], new["id"]); self.assertEqual(new["requeued_from"], "sf_r1")
            self.assertEqual(new["series_id"], "series_1"); self.assertEqual(new["repeat"], old["repeat"])
            self.assertTrue(utc(new["trigger_at"]) > datetime.now(timezone.utc))
            # second poll: the new one is in the future → nothing fires, nothing duplicates
            mgr._check_self_followups()
            self.assertEqual(len(mgr.fired), 1); self.assertEqual(len(self._bucket(root, "pending")), 1)

    def test_routine_survives_a_failed_fire(self):
        with tempfile.TemporaryDirectory() as root:
            mgr = self._mgr(root, ok=False)
            self._seed(root, {"id": "sf_r2", "choom_id": "c1", "choom_name": "Genesis", "prompt": "Morning", "reason": "",
                              "trigger_at": "2020-01-01T01:00:00Z", "consumed": False, "status": "pending",
                              "repeat": {"rule": "weekdays", "time": "07:00", "tz": TZ}})
            mgr._check_self_followups()
            self.assertEqual(self._bucket(root, "error"), ["sf_r2.json"])
            self.assertEqual(len(self._bucket(root, "pending")), 1)  # series continues

    def test_one_shot_does_not_requeue(self):
        with tempfile.TemporaryDirectory() as root:
            mgr = self._mgr(root)
            self._seed(root, {"id": "sf_o1", "choom_id": "c1", "choom_name": "Genesis", "prompt": "Check the build", "reason": "",
                              "trigger_at": "2020-01-01T01:00:00Z", "consumed": False, "status": "pending"})
            mgr._check_self_followups()
            self.assertEqual(len(mgr.fired), 1)
            self.assertNotIn("one of your routines", mgr.fired[0]["prompt"])
            self.assertEqual(self._bucket(root, "pending"), [])
