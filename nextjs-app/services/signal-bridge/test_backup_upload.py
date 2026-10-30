"""The daily Drive backup survives a dropped connection (2026-10-30).

The 5 AM backup died 28 s into the 2.6 GB dev.db upload with "[Errno 32]
Broken pipe" (also Oct 14): the client library doesn't retry a chunk whose
connection drops, and the job stopped at the first error, so the small files
after dev.db were never sent either. Run:
venv/bin/python -m unittest test_backup_upload -v
"""
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import httplib2
from googleapiclient.errors import HttpError

import google_client
import scheduler
from google_client import GoogleClient, UPLOAD_RESUME_WAITS

DONE = {"id": "f1", "name": "dev-2026-10-30.db", "webViewLink": "", "size": "9"}


class FakeConn:
    def __init__(self):
        self.closed = 0

    def close(self):
        self.closed += 1


class FakeRequest:
    """files().create(...): each next_chunk() gives the next outcome."""

    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.calls = 0
        self.conn = FakeConn()
        self.http = mock.Mock(http=mock.Mock(connections={"https:www.googleapis.com": self.conn}))

    def next_chunk(self, num_retries=0):
        self.calls += 1
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome


def http_error(status):
    return HttpError(httplib2.Response({"status": status}), b"{}")


class UploadResumes(unittest.TestCase):
    def setUp(self):
        fd, self.path = tempfile.mkstemp(suffix=".db")
        os.write(fd, b"sqlite...")
        os.close(fd)
        self.client = GoogleClient.__new__(GoogleClient)  # no OAuth in tests
        self.client.drive_service = mock.Mock()
        sleep = mock.patch.object(google_client.time, "sleep")
        self.sleep = sleep.start()
        self.addCleanup(sleep.stop)
        self.addCleanup(os.unlink, self.path)

    def upload(self, outcomes):
        self.request = FakeRequest(outcomes)
        self.client.drive_service.files.return_value.create.return_value = self.request
        return self.client.upload_to_drive(self.path, "folder", "dev-2026-10-30.db")

    def test_a_broken_pipe_resumes_on_a_fresh_connection(self):
        result = self.upload([BrokenPipeError(32, "Broken pipe"), (None, DONE)])
        self.assertEqual(result["id"], "f1")
        self.assertEqual(self.request.calls, 2)
        self.sleep.assert_called_once_with(UPLOAD_RESUME_WAITS[0])
        self.assertEqual(self.request.conn.closed, 1)

    def test_server_errors_resume_too(self):
        result = self.upload([http_error(503), ConnectionResetError(54, "reset"), (None, DONE)])
        self.assertEqual(result["id"], "f1")
        self.assertEqual(self.sleep.call_count, 2)

    def test_progress_starts_the_count_over(self):
        drops = [BrokenPipeError(32, "Broken pipe")] * len(UPLOAD_RESUME_WAITS)
        progress = (mock.Mock(progress=lambda: 0.5), None)
        result = self.upload(drops + [progress] + drops + [(None, DONE)])
        self.assertEqual(result["id"], "f1")

    def test_gives_up_after_the_last_wait(self):
        drops = [BrokenPipeError(32, "Broken pipe")] * (len(UPLOAD_RESUME_WAITS) + 1)
        with self.assertRaises(BrokenPipeError):
            self.upload(drops)
        self.assertEqual(self.sleep.call_count, len(UPLOAD_RESUME_WAITS))

    def test_a_real_refusal_is_not_retried(self):
        self.assertIsNone(self.upload([http_error(403)]))  # e.g. Drive quota full
        self.sleep.assert_not_called()
        with self.assertRaises(ValueError):
            self.upload([ValueError("bad body")])
        self.sleep.assert_not_called()


class BackupJobKeepsGoing(unittest.TestCase):
    def test_one_failed_file_does_not_stop_the_rest_and_the_owner_hears_which(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            (root / "data/reference-images").mkdir(parents=True)
            (root / "data/reference-images/face.png").write_bytes(b"png")
            dev, mem = root / "dev.db", root / "memories.db"
            dev.write_bytes(b"d")
            mem.write_bytes(b"m")

            uploaded = []

            def upload_to_drive(path, folder_id, name):
                if name.startswith("dev-"):
                    raise BrokenPipeError(32, "Broken pipe")
                uploaded.append(name.split("-20")[0])
                return {"id": name}

            google = mock.Mock(creds=None)
            google.upload_to_drive.side_effect = upload_to_drive
            m = scheduler.ScheduledTaskManager.__new__(scheduler.ScheduledTaskManager)
            m._create_local_snapshot = lambda: {"dev.db": dev, "memories.db": mem}
            m._get_or_create_backup_folder = lambda g: "folder"
            m._rotate_backups = mock.Mock()
            m.send_message_to_owner = mock.Mock()
            with mock.patch.object(scheduler, "get_google_client", return_value=google), \
                    mock.patch.object(scheduler, "is_task_enabled", return_value=True), \
                    mock.patch.object(scheduler, "APP_ROOT", str(root)):
                m._backup_databases()

        self.assertEqual(uploaded, ["memories", "config-bundle", "reference-images"])
        m.send_message_to_owner.assert_called_once()
        text = m.send_message_to_owner.call_args[0][0]
        self.assertIn("dev.db ([Errno 32] Broken pipe) did not reach Google Drive", text)
        self.assertIn("The rest uploaded.", text)
        self.assertIn("data/backups/daily/", text)
        m._rotate_backups.assert_called()


if __name__ == "__main__":
    unittest.main()
