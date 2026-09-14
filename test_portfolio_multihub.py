#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Régressions multi-hubs, contrats globaux et fallback de valorisation."""
import os
import tempfile
import unittest
from unittest.mock import patch

import database
import migrations
import portfolio_engine as engine
import portfolio_fees as fees
import portfolio_market_history as history
import repositories.market_history_repository as history_repo
import repositories.portfolio_repository as repo


CFG = {"broker_relations": 5, "accounting": 5,
       "standings": {"Caldari State": 5, "Caldari Navy": 8},
       "upwell_owner_fee": 0}


class MultiHubTests(unittest.TestCase):
    def setUp(self):
        from tests_sde_fixture import install
        install(self)
    def test_jita_amarr_rens_are_resolved_without_false_caldari_alias(self):
        jita = fees.rates_for_station(60003760, CFG)
        amarr = fees.rates_for_station(60008494, CFG)
        rens = fees.rates_for_station(60004588, CFG)
        self.assertEqual((10000002, 11900), (jita["region_id"], jita["broker_rate_ppm"]))
        self.assertEqual((10000043, 15000), (amarr["region_id"], amarr["broker_rate_ppm"]))
        self.assertEqual((10000030, 15000), (rens["region_id"], rens["broker_rate_ppm"]))
        self.assertIn("Amarr", amarr["station_name"])
        self.assertIn("Rens", rens["station_name"])
        self.assertNotIn("Caldari", amarr["station_owner"] + rens["station_owner"])

    def test_estimated_fee_breakdown_is_persistable_and_auditable(self):
        row = fees.enrich([{"transaction_id": 1, "type_id": 7,
                            "location_id": 60008494, "is_buy": False,
                            "quantity": 2, "unit_price_cents": 100_000}], CFG)[0]
        self.assertEqual("estimated", row["fees_status"])
        self.assertGreater(row["broker_fee_cents"] + row["sales_tax_cents"], 0)
        self.assertEqual("Amarr VIII (Oris) - Emperor Family Academy",
                         row["station_name"])

    def test_missing_local_sde_is_safe_and_does_not_claim_jita_standings(self):
        with patch.object(fees.stations.sde, "EVE_DB", "/missing/eve.db"):
            row = fees.rates_for_station(60003760, CFG)
        self.assertEqual("station-npc-owner-unresolved", row["fee_source"])
        self.assertIsNone(row["region_id"])
        self.assertEqual(15_000, row["broker_rate_ppm"])

    def test_market_missing_falls_back_to_known_fifo_cost_with_sell_fees(self):
        result = engine.build_workspace(
            transactions=[{"transaction_id": 1, "date": "2026-08-01",
                           "type_id": 7, "is_buy": True, "quantity": 1,
                           "unit_price_cents": 1_000_000,
                           "broker_rate_ppm": 15_000}],
            assets=[{"item_id": 9, "type_id": 7, "quantity": 1}],
            market={7: {"sell_fee_rate_ppm": 48_750,
                        "valuation_region_id": 10000043}})
        row = result["assets"][0]
        self.assertEqual("cost_fallback", row["market_source"])
        self.assertIsNone(row["market_median_cents"])
        self.assertEqual(row["avg_cost_cents"], row["inventory_value_cents"])
        self.assertGreater(int(row["projected_fees_cents"]), 0)

    def test_unknown_market_counts_as_zero_but_profit_remains_unknown(self):
        result = engine.build_workspace(
            assets=[{"item_id": 9, "type_id": 7, "quantity": 1}],
            market={7: {"sell_fee_rate_ppm": 48_750}})
        row = result["assets"][0]
        alert = next(value for value in result["alerts"]
                     if value["action"] == "LIST")
        self.assertIsNone(row["valuation_price_cents"])
        self.assertEqual('0', row["inventory_value_cents"])
        self.assertTrue(row['valuation_unavailable'])
        self.assertIsNone(row["projected_fees_cents"])
        self.assertIsNone(alert["value_cents"])

    def test_free_contract_is_known_zero_but_non_acquisition_is_ignored(self):
        asset = {"item_id": 1, "type_id": 42, "quantity": 1,
                 "is_blueprint_copy": True}
        free = {"contract_id": 1, "type_id": 42, "quantity": 1,
                "raw_quantity": -2, "allocated_cost_cents": 0,
                "is_acquisition": True, "is_included": True}
        row = engine.build_workspace(assets=[asset], contracts=[free])["assets"][0]
        self.assertTrue(row["cost_known"])
        self.assertEqual("0", row["avg_cost_cents"])
        self.assertEqual("0", row["inventory_value_cents"])
        ignored = dict(free, allocated_cost_cents=25_000,
                       is_acquisition=False)
        row = engine.build_workspace(assets=[asset], contracts=[ignored])["assets"][0]
        self.assertFalse(row["cost_known"])
        self.assertEqual('0', row["inventory_value_cents"])
        self.assertTrue(row['valuation_unavailable'])

    def test_contract_never_creates_or_seeds_a_division_fifo_position(self):
        contract = [{"contract_id": 9, "type_id": 42, "quantity": 1,
                     "raw_quantity": -2, "allocated_cost_cents": 25_000,
                     "acquired_at": "2026-01-01"}]
        self.assertEqual([], engine.build_workspace(contracts=contract)["assets"])
        sale = {"transaction_id": 1, "date": "2026-02-01", "type_id": 42,
                "is_buy": False, "quantity": 1, "unit_price_cents": 30_000}
        asset = {"item_id": 7, "type_id": 42, "quantity": 1,
                 "is_blueprint_copy": True}
        for _division in (2, 4):
            tx = engine.build_workspace(transactions=[sale], assets=[asset],
                                        contracts=contract)["transactions"][0]
            self.assertEqual("unknown_basis", tx["fifo_status"])
            self.assertIsNone(tx["realized_pnl_cents"])

    def test_incomplete_sale_preserves_covered_fifo_sales_and_empty_lots(self):
        transactions = [
            {"transaction_id": 1, "date": "2026-08-01", "type_id": 7,
             "is_buy": True, "quantity": 1, "unit_price_cents": 100},
            {"transaction_id": 2, "date": "2026-08-02", "type_id": 7,
             "is_buy": False, "quantity": 1, "unit_price_cents": 120},
            {"transaction_id": 3, "date": "2026-08-03", "type_id": 8,
             "is_buy": False, "quantity": 1, "unit_price_cents": 120},
        ]
        result = engine.build_workspace(transactions=transactions)
        # e77c59f intentionally retains covered sales; the unknown row stays unknown.
        self.assertEqual(result["summary"]["realized_pnl_cents"], '20')
        self.assertIsNone(result['transactions'][-1]['realized_pnl_cents'])
        self.assertEqual([], result["assets"])

    def test_bpc_contract_does_not_value_a_bpo_of_same_type(self):
        result = engine.build_workspace(
            assets=[{"item_id": 1, "type_id": 42, "quantity": 1,
                     "is_blueprint_copy": False}],
            contracts=[{"contract_id": 9, "type_id": 42, "quantity": 1,
                        "raw_quantity": -2, "allocated_cost_cents": 25_000}])
        self.assertEqual('0', result["assets"][0]["inventory_value_cents"])
        self.assertTrue(result['assets'][0]['valuation_unavailable'])


class RegionalHistoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_db = database.DB_PATH
        database.DB_PATH = os.path.join(self.temp.name, "portfolio.db")
        migrations.migrate()

    def tearDown(self):
        database.DB_PATH = self.old_db
        self.temp.cleanup()

    def test_domain_history_is_selected_without_silent_forge_mix(self):
        history_repo.upsert(10000002, 7, [{"date": "2026-08-01",
                            "average": 10, "highest": 11, "lowest": 9,
                            "volume": 1, "order_count": 1}])
        history_repo.upsert(10000043, 7, [{"date": "2026-08-01",
                            "average": 20, "highest": 21, "lowest": 19,
                            "volume": 2, "order_count": 2}])
        grouped, market, _regions = history.load_context(
            {"corporation_id": "202", "division_id": "4"}, None, [],
            [{"type_id": 7, "region_id": 10000043}], [], [])
        self.assertEqual(2000, grouped[7][0]["avg_cents"])
        self.assertEqual(10000043, market[7]["valuation_region_id"])
        self.assertFalse(market[7]["forge_fallback"])

    def test_unknown_region_uses_forge_only_as_explicit_fallback(self):
        history_repo.upsert(10000002, 7, [{"date": "2026-08-01",
                            "average": 10, "highest": 11, "lowest": 9,
                            "volume": 1, "order_count": 1}])
        grouped, market, regions = history.load_context(
            {"corporation_id": "202", "division_id": "4"}, None,
            [{"type_id": 7, "is_container": False}], [], [], [])
        self.assertEqual({}, regions)
        self.assertTrue(grouped[7])
        self.assertTrue(market[7]["forge_fallback"])
        self.assertEqual(10000002, market[7]["valuation_region_id"])

    def test_same_type_multiple_order_regions_has_stable_weighted_policy(self):
        orders = [{"type_id": 7, "region_id": 10000043,
                   "price_cents": 100, "volume_remain": 2},
                  {"type_id": 7, "region_id": 10000030,
                   "price_cents": 100, "volume_remain": 3}]
        first = history.type_regions({}, None, [], orders, [])
        second = history.type_regions({}, None, [], list(reversed(orders)), [])
        self.assertEqual(first, second)
        self.assertEqual(10000030, first[7])


if __name__ == "__main__":
    unittest.main(verbosity=2)
