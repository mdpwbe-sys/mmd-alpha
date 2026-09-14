#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Régressions du cache de découverte et de l'historique régional."""
import os
import tempfile
import unittest
from unittest.mock import patch

import database
import migrations
import portfolio_market_history as market_history
import portfolio_service as service
import repositories.portfolio_repository as repo

WALLET = {"corporation_id": "202", "division_id": "4"}


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.old = dict(service._DISCOVERY)

    def tearDown(self):
        service._DISCOVERY.clear()
        service._DISCOVERY.update(self.old)

    def test_consecutive_errors_keep_last_good_options(self):
        service._DISCOVERY.clear()
        service._DISCOVERY.update(at=0.0, data=None, last_good=None,
                                  last_good_fingerprint=None)
        good = {"marker": "good", "characters": [], "divisions": {"202": []},
                "containers": {}, "errors": []}
        bad = {"characters": [], "divisions": {}, "containers": {},
               "errors": [{"error": {"message": "ESI down"}}]}
        with patch.object(service.sso, "connected_chars",
                          return_value=[{"id": 101}]), \
             patch.object(service.sso, "character_capabilities",
                          return_value={"corporation_wallet": True}), \
             patch.object(service.esi, "discover_sources",
                          side_effect=[good, bad, bad]):
            service._discover(True)
            second = service._discover(True)
            third = service._discover(True)
        self.assertEqual("good", second["marker"])
        self.assertEqual("good", third["marker"])
        self.assertTrue(third["errors"])

    def test_exception_also_keeps_last_good_options(self):
        good = {"marker": "good", "characters": [], "divisions": {"202": []},
                "containers": {}, "errors": []}
        service._DISCOVERY.clear()
        service._DISCOVERY.update(at=0.0, data=good, last_good=good,
                                  fingerprint=((101, ()),),
                                  last_good_fingerprint=((101, ()),))
        with patch.object(service.sso, "connected_chars",
                          return_value=[{"id": 101}]), \
             patch.object(service.sso, "character_capabilities", return_value={}), \
             patch.object(service.esi, "discover_sources",
                          side_effect=TimeoutError("down")):
            data = service._discover(True)
        self.assertEqual("good", data["marker"])
        self.assertIn("down", data["errors"][0]["error"]["message"])


class RegionalHistoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_db = database.DB_PATH
        database.DB_PATH = os.path.join(self.temp.name, "portfolio.db")
        migrations.migrate()

    def tearDown(self):
        database.DB_PATH = self.old_db
        self.temp.cleanup()

    def test_partial_fetch_persists_only_successes(self):
        orders = [{"type_id": 7, "region_id": 10000043},
                  {"type_id": 8, "region_id": 10000030}]

        def fetch(url, include_cache_state=False):
            if "type_id=7" in url:
                return ([{"date": "2026-08-20", "average": 10,
                          "highest": 11, "lowest": 9, "volume": 2,
                          "order_count": 1}], "live")
            return ([{"date": "2026-08-19", "average": 20,
                      "highest": 21, "lowest": 19, "volume": 1,
                      "order_count": 1}], "stale_cache")

        with patch.object(market_history.order_repo, "load_orders",
                          return_value=orders), \
             patch.object(market_history.repo, "load_transactions",
                          return_value=[]), \
             patch.object(market_history.public_esi, "_load_cache"), \
             patch.object(market_history.public_esi, "_get", side_effect=fetch):
            result = market_history.refresh_current(WALLET, None)
        self.assertEqual({"requested": 2, "pending": 0, "failed": 0,
                          "stale": 1}, result)
        self.assertEqual(1000, repo.load_history(
            [7], region_id=10000043)[0]["avg_cents"])
        self.assertEqual([], repo.load_history([8], region_id=10000030))


if __name__ == "__main__":
    unittest.main(verbosity=2)
