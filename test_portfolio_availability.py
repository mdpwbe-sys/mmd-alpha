#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Régressions: jamais synchronisé n'est jamais un vrai zéro."""
import os
import tempfile
import unittest
from datetime import date

import database
import migrations
import portfolio_availability as availability
import portfolio_engine as engine
import portfolio_service as service
import repositories.portfolio_repository as repo
import repositories.portfolio_sync_repository as states


WALLET = {"key": "corp:202:division:4", "corporation_id": "202",
          "division_id": "4", "character_id": "101", "name": "Libre"}


class PortfolioAvailabilityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_db = database.DB_PATH
        database.DB_PATH = os.path.join(self.temp.name, "portfolio.db")
        migrations.migrate()

    def tearDown(self):
        database.DB_PATH = self.old_db
        self.temp.cleanup()

    def test_never_synced_masks_unknown_totals(self):
        data = service._workspace(WALLET, None)
        self.assertTrue(data["ok"])
        self.assertTrue(data["stale"])
        self.assertEqual("never_synced", data["availability"]["cash"]["state"])
        self.assertIsNone(data["summary"]["cash_cents"])
        self.assertIsNone(data["summary"]["fund_value_cents"])
        self.assertIsNone(data["summary"]["realized_pnl_cents"])

    def test_confirmed_empty_survives_offline_as_real_zero(self):
        repo.save_setting("cash_balances", {WALLET["key"]: "0"})
        states.mark_success("cash", "corporation", 202, 4, 1)
        states.mark_success("transactions", "corporation", 202, 4, 0)
        states.mark_success("orders", "corporation", 202, 4, 0)
        states.mark_success("contracts", "corporation", 202, 0, 0)
        data = service._workspace(WALLET, None)
        self.assertTrue(data["complete"])
        self.assertFalse(data["stale"])
        self.assertEqual("empty", data["availability"]["transactions"]["state"])
        self.assertEqual("0", data["summary"]["cash_cents"])
        self.assertEqual("0", data["summary"]["fund_value_cents"])
        self.assertEqual("0", data["summary"]["realized_pnl_cents"])

    def test_failure_after_empty_success_is_stale_not_unavailable(self):
        states.mark_success("transactions", "corporation", 202, 4, 0)
        states.mark_failure("transactions", "corporation", 202, 4,
                            {"kind": "network", "message": "ESI down"})
        data = service._workspace(WALLET, None)
        tx = data["availability"]["transactions"]
        self.assertEqual("stale", tx["state"])
        self.assertTrue(tx["available"])
        self.assertEqual("0", data["summary"]["realized_pnl_cents"])
        self.assertIn("ESI down", str(data["sync_errors"]))

    def test_coherent_empty_asset_snapshot_is_confirmed_empty(self):
        repo.save_asset_snapshot(101, None, [])
        states.mark_success("assets", "character", 101, 0, 0)
        asset = {"key": "char:101:container:303", "character_id": "101",
                 "item_id": "303", "name": "Vide"}
        data = service._workspace(WALLET, asset)
        self.assertEqual("empty", data["availability"]["assets"]["state"])

    def test_incomplete_regional_history_does_not_mask_valid_fifo_returns(self):
        """Market backfill errors affect completeness, not realized FIFO metrics."""
        today = date.today().isoformat()
        data = engine.build_workspace(transactions=[
            {"transaction_id": 1, "date": today, "type_id": 7,
             "is_buy": True, "quantity": 1, "unit_price_cents": 10_000},
            {"transaction_id": 2, "date": today, "type_id": 7,
             "is_buy": False, "quantity": 1, "unit_price_cents": 15_000},
        ])
        sources = {
            name: {"available": True, "state": "ready", "error": None}
            for name in ("cash", "transactions", "orders", "contracts", "assets")
        }
        result = availability.apply(data, sources, errors=[{
            "source": "market_history", "kind": "partial",
            "message": "Regional history: 517 pending, 0 failed, 0 stale cache",
        }])

        self.assertFalse(result["complete"])
        self.assertEqual("5000", result["summary"]["realized_pnl_cents"])
        self.assertIsNotNone(result["summary"]["monthly_return_bp"])

    def test_partial_valuation_keeps_known_unrealized_pnl(self):
        """One unknown position cannot erase a valid valuation on another one."""
        sources = {
            name: {"available": True, "state": "ready", "error": None}
            for name in ("cash", "transactions", "orders", "contracts", "assets")
        }
        data = {
            "summary": {
                "cash_cents": "0", "buy_escrow_cents": "0", "inventory_value_cents": "0",
                "fund_value_cents": "0", "realized_pnl_cents": "123456",
                "unrealized_pnl_cents": "654321", "monthly_return_bp": "420", "days_running": 1,
            },
            "assets": [
                {"cost_known": True, "valuation_price_cents": "500", "unrealized_pnl_cents": "654321"},
                {"cost_known": False, "valuation_price_cents": "0", "unrealized_pnl_cents": "0"},
            ],
            "alerts": [{"name": "known alert"}, {"name": "other alert"}],
        }
        result = availability.apply(data, sources, errors=[{
            "source": "market_history", "kind": "partial", "message": "Regional history: 504 pending",
        }])

        self.assertFalse(result["complete"])
        self.assertEqual("123456", result["summary"]["realized_pnl_cents"])
        self.assertEqual("654321", result["summary"]["unrealized_pnl_cents"])
        self.assertEqual("420", result["summary"]["monthly_return_bp"])
        self.assertEqual(2, len(result["alerts"]))

    def test_unrealized_is_unavailable_when_no_position_has_a_usable_valuation(self):
        sources = {
            name: {"available": True, "state": "ready", "error": None}
            for name in ("cash", "transactions", "orders", "contracts", "assets")
        }
        data = {
            "summary": {"cash_cents": "0", "buy_escrow_cents": "0", "inventory_value_cents": "0",
                        "fund_value_cents": "0", "realized_pnl_cents": "123", "unrealized_pnl_cents": "0",
                        "monthly_return_bp": "42", "days_running": 1},
            "assets": [{"cost_known": False, "valuation_price_cents": "0", "unrealized_pnl_cents": "0"}],
            "alerts": [],
        }
        result = availability.apply(data, sources)
        self.assertIsNone(result["summary"]["unrealized_pnl_cents"])
        self.assertEqual("123", result["summary"]["realized_pnl_cents"])

    def test_unknown_historical_sale_does_not_mask_covered_fifo_profit(self):
        """Known FIFO sales still form a usable realized P&L and 30-day return."""
        today = date.today().isoformat()
        result = engine.build_workspace(transactions=[
            # Legacy sale without a locally-known purchase: unavailable row only.
            {"transaction_id": 1, "date": today, "type_id": 9, "is_buy": False,
             "quantity": 1, "unit_price_cents": 20_000},
            {"transaction_id": 2, "date": today, "type_id": 7, "is_buy": True,
             "quantity": 1, "unit_price_cents": 10_000},
            {"transaction_id": 3, "date": today, "type_id": 7, "is_buy": False,
             "quantity": 1, "unit_price_cents": 15_000},
        ])

        self.assertEqual("5000", result["summary"]["realized_pnl_cents"])
        self.assertIsNotNone(result["summary"]["monthly_return_bp"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
