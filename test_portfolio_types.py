#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Noms d'items ESI lisibles sur une VM sans SDE."""
import os
import tempfile
import unittest
from unittest.mock import patch

import database
import migrations
import portfolio_types as types


class PortfolioTypeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_db = database.DB_PATH
        database.DB_PATH = os.path.join(self.temp.name, "portfolio.db")
        migrations.migrate()

    def tearDown(self):
        database.DB_PATH = self.old_db
        self.temp.cleanup()

    def test_type_name_is_fetched_once_then_available_offline(self):
        with patch.object(types.core, "iname", return_value="Item #34"), \
             patch.object(types.public_esi, "_load_cache"), \
             patch.object(types.public_esi, "_get",
                          return_value=({"name": "Tritanium"}, False)) as get:
            result = types.refresh([34])
            first = types.item_name(34)
            cached = types.refresh([34])
        self.assertEqual({"requested": 1, "pending": 0, "failed": 0}, result)
        self.assertEqual("Tritanium", first)
        self.assertEqual(0, cached["requested"])
        get.assert_called_once()

    def test_local_sde_name_has_priority_and_skips_network(self):
        with patch.object(types.core, "iname", return_value="Local Name"), \
             patch.object(types.public_esi, "_get") as get:
            result = types.refresh([34])
            name = types.item_name(34)
        self.assertEqual("Local Name", name)
        self.assertEqual(0, result["requested"])
        get.assert_not_called()


if __name__ == "__main__":
    unittest.main(verbosity=2)
