"""resolve_signal_room (2026-09-12): a 'group:' Signal message must never
answer with a bare 404 when the configured room was deleted.
Run: venv/bin/python -m unittest test_signal_room_resolve -v"""
import unittest
import requests
from bridge import resolve_signal_room, parse_group_prefix


def http_error(status):
    resp = requests.Response(); resp.status_code = status
    return requests.HTTPError(f"{status} Client Error", response=resp)


class Resolve(unittest.TestCase):
    def test_configured_room_exists(self):
        room, note = resolve_signal_room("r1", list_rooms=lambda: [], get_room=lambda rid: {"id": rid, "title": "Lounge"})
        self.assertEqual(room["id"], "r1"); self.assertIsNone(note)

    def test_deleted_default_falls_back_to_newest_live_room(self):
        def get_room(rid): raise http_error(404)
        rooms = [{"id": "old", "title": "Old", "updatedAt": "2026-09-01"},
                 {"id": "arch", "title": "Archived", "archived": True, "updatedAt": "2026-09-12"},
                 {"id": "new", "title": "Family lounge", "updatedAt": "2026-09-10"}]
        room, note = resolve_signal_room("gone", list_rooms=lambda: rooms, get_room=get_room)
        self.assertEqual(room["id"], "new")
        self.assertIn("was deleted", note); self.assertIn("Family lounge", note)

    def test_no_default_and_no_rooms(self):
        room, note = resolve_signal_room(None, list_rooms=lambda: [], get_room=lambda rid: {})
        self.assertIsNone(room); self.assertIn("No group room", note)

    def test_no_default_but_a_room_exists(self):
        room, note = resolve_signal_room("", list_rooms=lambda: [{"id": "a", "title": "A"}], get_room=lambda rid: {})
        self.assertEqual(room["id"], "a"); self.assertIn("was never set", note)

    def test_other_http_errors_propagate(self):
        def get_room(rid): raise http_error(500)
        with self.assertRaises(requests.HTTPError):
            resolve_signal_room("r1", list_rooms=lambda: [], get_room=get_room)

    def test_archived_default_is_replaced(self):
        room, note = resolve_signal_room("r1", list_rooms=lambda: [{"id": "r2", "title": "Live"}], get_room=lambda rid: {"id": rid, "archived": True})
        self.assertEqual(room["id"], "r2"); self.assertIsNotNone(note)


if __name__ == "__main__":
    unittest.main()


class GroupPrefixTests(unittest.TestCase):
    """'group' followed by a space routes to the room, not only 'group:' (2026-09-17)."""

    def test_accepts_colon_comma_dash_and_plain_space(self):
        self.assertEqual(parse_group_prefix("group: hi girls"), "hi girls")
        self.assertEqual(parse_group_prefix("Group, hi girls"), "hi girls")
        self.assertEqual(parse_group_prefix("room - hi girls"), "hi girls")
        self.assertEqual(parse_group_prefix("Group the storm is moving away"), "the storm is moving away")
        self.assertEqual(parse_group_prefix("  ROOM:hello"), "hello")

    def test_ordinary_messages_are_not_group(self):
        self.assertIsNone(parse_group_prefix("grouping the parts by size"))
        self.assertIsNone(parse_group_prefix("rooms are cold tonight"))
        self.assertIsNone(parse_group_prefix("Aloy, what's the weather"))
        self.assertIsNone(parse_group_prefix("group"))
        self.assertIsNone(parse_group_prefix(""))
        self.assertIsNone(parse_group_prefix(None))
