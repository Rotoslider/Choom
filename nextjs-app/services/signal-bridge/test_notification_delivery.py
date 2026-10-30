"""A notification without files is delivered without a "Failed to deliver" warning (2026-10-30).

/api/notifications copies the Notification row, so a message without files comes with
"filePaths": null. The bridge sent it and marked it delivered, then its log line took len() of
that None and logged "Failed to deliver notification ...: object of type 'NoneType' has no len()"
after every notification (396 times by Oct 30). Run:
venv/bin/python -m unittest test_notification_delivery -v
"""
import unittest
from unittest import mock

import scheduler


def api_row(**extra):
    """One notification as GET /api/notifications returns it."""
    row = {"id": "n1", "choomId": "c1", "message": "From the NUC: the glass backup failed.",
           "includeAudio": False, "imageIds": None, "filePaths": None, "delivered": False}
    row.update(extra)
    return row


class NotificationDeliveryTest(unittest.TestCase):
    def check(self, rows):
        m = scheduler.ScheduledTaskManager.__new__(scheduler.ScheduledTaskManager)
        m.default_choom = "Genesis"
        m.choom = mock.Mock()
        m.choom.get_choom_by_id.return_value.name = "Genesis"  # (Mock(name=...) would name the mock)
        m.send_message_to_owner = mock.Mock()
        m._send_notification_images = mock.Mock()
        m._send_notification_files = mock.Mock()
        got = mock.Mock(status_code=200)
        got.json.return_value = rows
        with mock.patch.object(scheduler.requests, "get", return_value=got), \
                mock.patch.object(scheduler.requests, "delete") as delete, \
                mock.patch.object(scheduler.logger, "warning") as warning:
            m._check_notifications()
        return m, delete, warning

    def test_no_files_is_delivered_without_a_warning(self):
        m, delete, warning = self.check([api_row()])
        m.send_message_to_owner.assert_called_once_with(
            "From the NUC: the glass backup failed.", include_audio=False, choom_name="Genesis")
        delete.assert_called_once()
        self.assertEqual(delete.call_args.kwargs["json"], {"ids": ["n1"]})
        warning.assert_not_called()

    def test_images_and_files_still_go_out(self):
        rows = [api_row(images=[{"id": "i1", "url": "/x.png"}], filePaths=["/w/sheet.png", "/w/notes.md"])]
        with mock.patch("pending_files.add_batch") as add_batch:
            m, delete, warning = self.check(rows)
        m._send_notification_images.assert_called_once()
        m._send_notification_files.assert_called_once_with(["/w/sheet.png"], "Genesis")
        add_batch.assert_called_once()
        self.assertEqual(delete.call_args.kwargs["json"], {"ids": ["n1"]})
        warning.assert_not_called()


if __name__ == "__main__":
    unittest.main()
