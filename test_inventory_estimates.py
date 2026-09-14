import unittest
import portfolio_engine as engine


class InventoryEstimates(unittest.TestCase):
    def test_history_batch_progresses_past_empty_responses(self):
        from portfolio_market_history import pending_history_pairs
        regions = {1: 10, 2: 10, 3: 10}
        self.assertEqual([(10, 2), (10, 3)], pending_history_pairs(
            regions, {'10:1': 9999}, 10000, lambda r, t: False))
        self.assertEqual([(10, 2), (10, 3), (10, 1)], pending_history_pairs(
            regions, {'10:1': 9999}, 20000, lambda r, t: False))

    def test_missing_price_counts_as_zero_without_fabricated_profit(self):
        data = engine.build_workspace(assets=[{'type_id': 7, 'quantity': 1}], cash_cents=123)
        self.assertEqual('0', data['summary']['inventory_value_cents'])
        self.assertEqual('123', data['summary']['fund_value_cents'])
        self.assertEqual(1, data['summary']['unvalued_types'])
        self.assertIsNone(data['assets'][0]['unrealized_pnl_cents'])

    def test_bpc_must_not_use_bpo_market_price(self):
        data = engine.build_workspace(assets=[{'type_id': 7, 'quantity': 1, 'is_blueprint_copy': True}],
                                      market={7: {'current_sell_cents': 99999}})
        self.assertEqual('0', data['assets'][0]['inventory_value_cents'])

    def test_four_runs(self):
        from portfolio_valuation import bpc_value_cents
        self.assertEqual(24000000000, bpc_value_cents(20000000000, 14000000000, 4))
        self.assertEqual(0, bpc_value_cents(100, 200, 4))
        self.assertIsNone(bpc_value_cents(100, None, 4))

    def test_bpc_supplied_manufacturing_estimate(self):
        data = engine.build_workspace(assets=[{'type_id': 7, 'quantity': 1, 'is_blueprint_copy': True,
            'runs': 4, 'product_value_per_run_cents': 20000, 'materials_per_run_cents': 14000}])
        self.assertEqual('24000', data['assets'][0]['inventory_value_cents'])
