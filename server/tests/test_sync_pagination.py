#!/usr/bin/env python3
"""Regression tests for deterministic delta-sync pagination."""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import core.database as database_module  # noqa: E402


class SyncPaginationTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_db_path = database_module.DB_PATH
        database_module.DB_PATH = Path(self.temp_dir.name) / "superbrain.db"
        self.db = database_module.Database()

        rows = [
            ("charlie", "2026-01-02T12:00:00"),
            ("alpha", "2026-01-02T12:00:00"),
            ("echo", "2026-01-03T12:00:00"),
            ("bravo", "2026-01-02T12:00:00"),
            ("delta", "2026-01-03T12:00:00"),
        ]
        self.db._conn.executemany(
            "INSERT INTO analyses (shortcode, updated_at, tags) VALUES (?, ?, '[]')",
            rows,
        )
        self.db._conn.commit()

    def tearDown(self):
        self.db._conn.close()
        database_module.DB_PATH = self.original_db_path
        self.temp_dir.cleanup()

    def test_pages_use_stable_updated_at_and_shortcode_order(self):
        since = "2026-01-01T00:00:00"

        first = self.db.get_posts_since(since, limit=2, offset=0)
        second = self.db.get_posts_since(since, limit=2, offset=2)
        third = self.db.get_posts_since(since, limit=2, offset=4)

        self.assertEqual([row["shortcode"] for row in first], ["alpha", "bravo"])
        self.assertEqual([row["shortcode"] for row in second], ["charlie", "delta"])
        self.assertEqual([row["shortcode"] for row in third], ["echo"])


if __name__ == "__main__":
    unittest.main()
