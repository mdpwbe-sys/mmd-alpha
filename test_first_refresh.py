"""First-refresh regression: no legacy Evernus database is available."""
import ast
import json
from pathlib import Path
import tempfile
import time
import types
import sys
import unittest
from unittest.mock import Mock, patch

import database
import migrations
import mmd_esi


class FirstRefreshTests(unittest.TestCase):
    def test_known_types_come_from_mmd_active_snapshots(self):
        with patch('repositories.order_repository.get_all_latest_character_orders',
                   return_value=[{'type_id': 34, 'volume_remain': 5},
                                 {'type_id': 34, 'volume_remain': 2},
                                 {'type_id': 35, 'volume_remain': 0}]):
            self.assertEqual(mmd_esi.live_type_ids(), [34])

    def test_authenticated_service_fetches_public_books_for_discovered_orders(self):
        import mmd_core
        import mmd_esi_orders as orders
        own = [{'order_id': '1', 'type_id': 34, 'side': 1}]
        public = [{'order_id': '2', 'type_id': 34, 'side': 1}]
        with patch.object(orders, 'fetch_all_orders', return_value=(own, [], [101])), \
             patch.object(orders, '_env_structure_ids', return_value=set()), \
             patch.object(orders.sso, 'connected_chars', return_value=[]), \
             patch.object(mmd_esi, 'get_live_public_for', return_value=([34], public, 0.1, [])) as fetch, \
             patch.object(mmd_core, '_scan_core', return_value={'ok': True}) as classify:
            self.assertTrue(orders.scan_authed(order_books=None)['ok'])
        fetch.assert_called_once_with([34], include_failures=True)
        self.assertEqual(classify.call_args.args[:2], (own, public))

    def test_empty_mmd_database_has_no_legacy_dependency(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / 'app_data.db')
            migrations.migrate(path)
            with patch.object(database, 'DB_PATH', path), patch.object(mmd_esi, 'MAIN_DB', path):
                self.assertEqual(mmd_esi.live_type_ids(), [])

    def test_first_authenticated_refresh_uses_sso_without_legacy_lookup(self):
        tree = ast.parse(Path(__file__).with_name('mmd_gui.py').read_text(encoding='utf-8-sig'))
        api = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'Api')
        scan = next(n for n in api.body if isinstance(n, ast.FunctionDef) and n.name == 'scan')
        metadata = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == '_set_count_sync_metadata')
        module = ast.Module(body=[metadata, scan], type_ignores=[])
        core = Mock()
        core.scan_authed.return_value = {'ok': False, 'error': 'test stops after service call'}
        window = Mock()
        scope = dict(time=time, json=json, WIN=window, core=core,
                     set_status_js=Mock(), _set_count_sync_metadata=Mock(),
                     threading=types.SimpleNamespace(Thread=lambda target, **kw:
                         types.SimpleNamespace(start=target)))
        exec(compile(module, 'scan-regression', 'exec'), scope)
        import mmd_sso
        with patch.object(mmd_sso, 'is_connected', return_value=True), \
             patch.object(mmd_sso, 'connected_chars', return_value=[]), \
             patch.object(mmd_esi, 'live_type_ids', side_effect=AssertionError('legacy lookup')) as legacy:
            scope['scan'](types.SimpleNamespace())
        legacy.assert_not_called()
        core.scan_authed.assert_called_once_with(order_books=None)
        self.assertFalse(any('scanError' in str(call) for call in window.evaluate_js.call_args_list))
        scope['save_cache'] = Mock()
        for failed, expected in (([], ['101']), ([34], [])):
            with self.subTest(failed=failed):
                data = {'ok': True, 'orders_full': [{'type_id': 34, 'char_id': '101'}],
                        'orders_to_update_by_char': {'101': {'total': 2, 'buy': 2, 'sell': 0}},
                        'synced_char_ids': ['101'],
                        'public_sync': {'requested_type_ids': [34], 'failed_type_ids': failed,
                                        'items': 1, 'orders': 0, 'sec': 0.1}}
                core.scan_authed.return_value = data
                with patch.object(mmd_sso, 'is_connected', return_value=True), \
                     patch.object(mmd_sso, 'connected_chars', return_value=[]), \
                     patch.dict(sys.modules, {'memory_store': Mock()}), \
                     patch.object(mmd_esi, 'get_live_public_for', side_effect=AssertionError('prefetch from old snapshot')):
                    scope['scan'](types.SimpleNamespace(_last_orders=[{'type_id': 35}],
                                                       _remember_visible_orders=Mock()))
                self.assertEqual(data['synced_char_ids'], expected)
                self.assertEqual(data.get('esi', {}).get('items'), 1)


if __name__ == '__main__':
    unittest.main()
