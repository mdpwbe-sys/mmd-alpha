#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Régressions du chemin réel refresh ESI -> SQLite, sans réseau."""
import os
import tempfile
import unittest
from unittest.mock import patch

import database
import mmd_esi_auth as auth
import migrations
import portfolio_refresh as refresh
import repositories.corporation_order_repository as order_repo
import repositories.portfolio_repository as repo
import repositories.portfolio_sync_repository as states


WALLET = {"key": "corp:202:division:4", "corporation_id": "202",
          "division_id": "4", "character_id": "101", "name": "Libre"}
CHARACTERS = [
    {"id": 101, "corporation_id": 202,
     "capabilities": {"corporation_wallet": True, "corporation_orders": True,
                      "corporation_contracts": True}},
    {"id": 102, "corporation_id": 202,
     "capabilities": {"corporation_wallet": True, "corporation_orders": True,
                      "corporation_contracts": True}},
]


def success(data, headers=None):
    return auth.EsiResult(data, headers or {}, status=200)


class RefreshTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_db = database.DB_PATH
        database.DB_PATH = os.path.join(self.temp.name, "portfolio.db")
        migrations.migrate()
        self.location_patch = patch.object(refresh.locations, "refresh_current",
                                           return_value={"pending": 0, "failed": 0})
        self.location_patch.start()
        self.type_patch = patch.object(refresh.types, "refresh_current",
                                       return_value={"pending": 0, "failed": 0})
        self.type_patch.start()

    def tearDown(self):
        self.type_patch.stop()
        self.location_patch.stop()
        database.DB_PATH = self.old_db
        self.temp.cleanup()

    def _capabilities(self, _character_id):
        return {"corporation_wallet": True, "corporation_orders": True,
                "corporation_contracts": True}

    def test_successful_empty_refresh_records_real_empty_not_false_zero(self):
        with patch.object(refresh.sso, "character_capabilities",
                          side_effect=self._capabilities), \
             patch.object(refresh.esi, "fetch_corporation_transactions",
                          return_value=success([])), \
             patch.object(refresh.corporation_orders_esi,
                          "fetch_corporation_orders", return_value=success([])), \
             patch.object(refresh.esi, "fetch_corporation_balance",
                          return_value=success({"balance_cents": 0})), \
             patch.object(refresh.esi, "fetch_corporation_contract_assets",
                          return_value=success([], {"X-Contracts-Pending": "0",
                                                    "X-Contracts-Failed": "0"})), \
             patch.object(refresh.market_history, "refresh_current",
                          return_value={"pending": 0, "failed": 0}):
            errors = refresh.run(WALLET, None, CHARACTERS)
        self.assertEqual([], errors)
        self.assertEqual("0", repo.get_settings()["cash_balances"][WALLET["key"]])
        self.assertEqual(0, states.get_state(
            "transactions", "corporation", 202, 4)["last_success_count"])
        self.assertEqual(0, states.get_state(
            "orders", "corporation", 202, 7)["last_success_count"])
        self.assertEqual(0, states.get_state(
            "contracts", "corporation", 202, 0)["last_success_count"])

    def test_second_corporation_token_is_used_after_first_is_forbidden(self):
        calls = []

        def transactions(_corp, _div, character_id, **_options):
            calls.append(character_id)
            if character_id == 101:
                return auth.failure("/wallet", "forbidden", "role absent", 403)
            return success([{"transaction_id": 9, "date": "2026-08-20",
                             "type_id": 7, "location_id": 60008494,
                             "is_buy": True, "quantity": 1,
                             "unit_price_cents": 100_000}])

        with patch.object(refresh.sso, "character_capabilities",
                          side_effect=self._capabilities), \
             patch.object(refresh.esi, "fetch_corporation_transactions",
                          side_effect=transactions), \
             patch.object(refresh.corporation_orders_esi,
                          "fetch_corporation_orders", return_value=success([])), \
             patch.object(refresh.esi, "fetch_corporation_balance",
                          return_value=success({"balance_cents": 0})), \
             patch.object(refresh.esi, "fetch_corporation_contract_assets",
                          return_value=success([], {"X-Contracts-Pending": "0",
                                                    "X-Contracts-Failed": "0"})), \
             patch.object(refresh.market_history, "refresh_current",
                          return_value={"pending": 0, "failed": 0}):
            errors = refresh.run(WALLET, None, CHARACTERS)
        self.assertEqual([101, 102], calls)
        self.assertEqual([], errors)
        self.assertEqual(9, repo.load_transactions(
            "corporation", 202, 4)[0]["transaction_id"])

    def test_failed_refresh_preserves_cache_and_marks_every_order_division(self):
        transaction = {"owner_kind": "corporation", "owner_id": 202,
                       "division_id": 4, "transaction_id": 9,
                       "date": "2026-08-20", "type_id": 7,
                       "location_id": 60003760, "is_buy": True,
                       "quantity": 1, "unit_price_cents": 100_000}
        repo.upsert_transactions([transaction])
        order_repo.replace_orders(202, [{"order_id": 8, "division_id": 4,
                                         "type_id": 7, "location_id": 60003760,
                                         "is_buy_order": True, "price_cents": 90_000,
                                         "volume_remain": 1}])
        repo.save_setting("cash_balances", {WALLET["key"]: "123"})
        denied = auth.failure("/corp", "forbidden", "role absent", 403)
        with patch.object(refresh.sso, "character_capabilities",
                          side_effect=self._capabilities), \
             patch.object(refresh.esi, "fetch_corporation_transactions",
                          return_value=denied), \
             patch.object(refresh.corporation_orders_esi,
                          "fetch_corporation_orders", return_value=denied), \
             patch.object(refresh.esi, "fetch_corporation_balance",
                          return_value=denied), \
             patch.object(refresh.esi, "fetch_corporation_contract_assets",
                          return_value=denied), \
             patch.object(refresh.market_history, "refresh_current",
                          return_value={"pending": 0, "failed": 0}):
            errors = refresh.run(WALLET, None, CHARACTERS)
        self.assertEqual(4, len(errors))
        self.assertEqual(9, repo.load_transactions(
            "corporation", 202, 4)[0]["transaction_id"])
        self.assertEqual(8, order_repo.load_orders(202, 4)[0]["order_id"])
        self.assertEqual("123", repo.get_settings()["cash_balances"][WALLET["key"]])
        for division in range(1, 8):
            self.assertEqual("error", states.get_state(
                "orders", "corporation", 202, division)["last_attempt_status"])
        with patch.object(refresh.sso, "character_capabilities",
                          side_effect=self._capabilities), \
             patch.object(refresh.corporation_orders_esi,
                          "fetch_corporation_orders", return_value=success([])), \
             patch.object(refresh.corporation_orders, "replace_orders",
                          side_effect=RuntimeError("sqlite cassé")):
            persistence_errors = []
            refresh._sync_orders(WALLET, CHARACTERS, persistence_errors)
        self.assertEqual(1, len(persistence_errors))
        self.assertTrue(all(states.get_state("orders", "corporation", 202, div)
                            ["last_attempt_status"] == "error" for div in range(1, 8)))

    def test_unexpected_source_exception_does_not_abort_later_sources(self):
        with patch.object(refresh, "_sync_transactions",
                          side_effect=RuntimeError("sqlite cassé")), \
             patch.object(refresh, "_sync_orders") as orders, \
             patch.object(refresh, "_sync_cash") as cash, \
             patch.object(refresh, "_sync_contracts") as contracts, \
             patch.object(refresh.market_history, "refresh_current",
                          return_value={"pending": 0, "failed": 0}):
            errors = refresh.run(WALLET, None, CHARACTERS)
        self.assertEqual("transactions", errors[0]["source"])
        orders.assert_called_once()
        cash.assert_called_once()
        contracts.assert_called_once()
        self.assertEqual("error", states.get_state(
            "transactions", "corporation", 202, 4)["last_attempt_status"])

    def test_stale_market_history_keeps_refresh_partial(self):
        with patch.object(refresh, "_sync_transactions"), \
             patch.object(refresh, "_sync_orders"), \
             patch.object(refresh, "_sync_cash"), \
             patch.object(refresh, "_sync_contracts"), \
             patch.object(refresh.market_history, "refresh_current",
                          return_value={"pending": 0, "failed": 0, "stale": 1}):
            errors = refresh.run(WALLET, None, CHARACTERS)
        self.assertEqual("market_history", errors[0]["source"])
        self.assertIn("1 cache expiré", errors[0]["message"])

if __name__ == "__main__":
    unittest.main(verbosity=2)
