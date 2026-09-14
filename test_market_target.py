import unittest
from eve_market_target import choose

class MarketTargetTests(unittest.TestCase):
    def test_preferred_online(self):
        self.assertEqual(choose(2, [{'id': 1}, {'id': 2}], lambda _: True), '2')
    def test_preferred_offline_uses_online_pilot(self):
        self.assertEqual(choose(2, [{'id': 1}, {'id': 2}], lambda cid: cid == '1'), '1')
    def test_sso_disconnected_owner_uses_online_pilot(self):
        self.assertEqual(choose(9, [{'id': 1}], lambda _: True), '1')
    def test_unknown_is_not_offline(self):
        self.assertEqual(choose(2, [{'id': 1}, {'id': 2}], lambda _: None), '2')
    def test_all_without_source_prefers_fresh_local(self):
        self.assertEqual(choose(None, [{'id': 1}, {'id': 2}], lambda _: None, [2]), '2')
    def test_all_offline_does_not_send_market_command(self):
        self.assertIsNone(choose(2, [{'id': 1}, {'id': 2}], lambda _: False))

if __name__ == '__main__': unittest.main()
