#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Résolution ESI des hubs sur une VM sans eve.db local."""
import os
import tempfile
import unittest
from unittest.mock import patch

import database
import migrations
import portfolio_locations as locations


class PortfolioLocationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_db = database.DB_PATH
        database.DB_PATH = os.path.join(self.temp.name, "portfolio.db")
        migrations.migrate()

    def tearDown(self):
        database.DB_PATH = self.old_db
        self.temp.cleanup()

    def test_amarr_is_resolved_and_cached_without_local_sde(self):
        calls = []

        def get(url):
            calls.append(url)
            if "/stations/60008494/" in url:
                return ({"name": "Amarr VIII (Oris) - Emperor Family Academy",
                         "owner": 1000086, "system_id": 30002187}, False)
            if "/systems/30002187/" in url:
                return ({"constellation_id": 20000322}, False)
            if "/constellations/20000322/" in url:
                return ({"region_id": 10000043}, False)
            return None, False

        with patch.object(locations.sde, "EVE_DB", "/missing/eve.db"), \
             patch.object(locations.public_esi, "_load_cache"), \
             patch.object(locations.public_esi, "_get", side_effect=get):
            result = locations.refresh([60008494], [])
            details = locations.station_details(60008494)
        self.assertEqual({"requested": 1, "pending": 0, "failed": 0}, result)
        self.assertEqual(10000043, details["region_id"])
        self.assertEqual(1000086, details["npc_owner_id"])
        self.assertIn("Amarr", details["name"])
        self.assertEqual(3, len(calls))

    def test_upwell_uses_authorized_info_then_public_map_chain(self):
        structure_id = 1_000_000_000_001

        def get(url):
            if "/systems/30000144/" in url:
                return ({"constellation_id": 20000020}, False)
            if "/constellations/20000020/" in url:
                return ({"region_id": 10000002}, False)
            return None, False

        info = {"name": "Perimeter - Test", "solarSystemID": 30000144}
        with patch.object(locations.sde, "EVE_DB", "/missing/eve.db"), \
             patch.object(locations.public_esi, "_load_cache"), \
             patch.object(locations.public_esi, "_get", side_effect=get), \
             patch.object(locations.authenticated_esi, "fetch_structure_info",
                          side_effect=[None, info]) as fetch:
            result = locations.refresh([structure_id], [101, 102])
            details = locations.station_details(structure_id)
        self.assertEqual(0, result["failed"])
        self.assertEqual(10000002, details["region_id"])
        self.assertFalse(details["is_npc"])
        self.assertEqual(2, fetch.call_count)


if __name__ == "__main__":
    unittest.main(verbosity=2)
