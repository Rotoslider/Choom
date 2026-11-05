"""Config snapshots are pruned by when they were taken (2026-11-05).

The app names its snapshots in UTC ("bridge-config_2026-11-05T14-43-30.json"), this bridge in
local time ("bridge-config_20261101_205003.json"), in the same folder. Pruning to 10 by plain
name order kept only the bridge's, because "20261101" sorts above "2026-11-05".
Run: venv/bin/python -m unittest test_config_snapshots -v
"""
import os
import shutil
import tempfile
import unittest
from datetime import datetime, timezone
from unittest import mock

import task_config

BRIDGE_TEN = [
    "bridge-config_20261026_090011.json", "bridge-config_20261026_170259.json",
    "bridge-config_20261026_212232.json", "bridge-config_20261026_212235.json",
    "bridge-config_20261030_063003.json", "bridge-config_20261101_074623.json",
    "bridge-config_20261101_074625.json", "bridge-config_20261101_090009.json",
    "bridge-config_20261101_090058.json", "bridge-config_20261101_205003.json",
]
APP_ONE = "bridge-config_2026-11-05T14-43-30.json"
OTHER = "20260916-111527-model-cleanup.json"


class SnapshotPruning(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="cfg-snap-")
        self.snaps = os.path.join(self.tmp, "snaps")
        os.makedirs(self.snaps)
        self.config = os.path.join(self.tmp, "bridge-config.json")
        with open(self.config, "w") as f:
            f.write("{}")
        for name in BRIDGE_TEN + [APP_ONE, OTHER]:
            with open(os.path.join(self.snaps, name), "w") as f:
                f.write("{}")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_names_read_as_the_right_instant(self):
        self.assertEqual(task_config._snapshot_time(APP_ONE),
                         datetime(2026, 11, 5, 14, 43, 30, tzinfo=timezone.utc).timestamp())
        self.assertEqual(task_config._snapshot_time("bridge-config_20261101_205003.json"),
                         datetime(2026, 11, 1, 20, 50, 3).timestamp())
        self.assertIsNone(task_config._snapshot_time(OTHER))

    def test_the_app_snapshot_survives_and_the_oldest_bridge_ones_go(self):
        with mock.patch.object(task_config, "SNAPSHOT_DIR", self.snaps), \
             mock.patch.object(task_config, "CONFIG_FILE", self.config):
            task_config._snapshot_config()
        left = os.listdir(self.snaps)
        self.assertIn(APP_ONE, left)
        self.assertIn(OTHER, left)
        self.assertNotIn("bridge-config_20261026_090011.json", left)
        self.assertNotIn("bridge-config_20261026_170259.json", left)
        self.assertEqual(len([f for f in left if f.startswith("bridge-config_")]), 10)


if __name__ == "__main__":
    unittest.main()
