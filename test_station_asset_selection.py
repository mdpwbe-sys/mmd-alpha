import unittest
from unittest.mock import patch
import portfolio_asset_selection as selection
import portfolio_service as service

class StationSelectionTests(unittest.TestCase):
    def test_station_includes_loose_assets_and_nested_containers_only(self):
        items = [dict(item_id=1, location_id=6001, parent_item_id=None),
                 dict(item_id=2, location_id=1, parent_item_id=1),
                 dict(item_id=3, location_id=2, parent_item_id=2),
                 dict(item_id=4, location_id=6001, parent_item_id=None),
                 dict(item_id=5, location_id=6002, parent_item_id=None)]
        with patch.object(selection.repo, 'load_latest_assets', return_value={'snapshot': 's', 'items': items}):
            result = selection.load_selected(101, 6001, source_kind='station')
            self.assertEqual([r['item_id'] for r in result['items']], [1, 2, 3, 4])
            self.assertEqual([r['item_id'] for r in selection.load_selected(101, 1)['items']], [1, 2, 3])

    def test_options_group_containers_beneath_selectable_station(self):
        discovery = {'characters': [{'id': 101, 'name': 'Pilot A'}],
                     'containers': {'101': [{'item_id': 1, 'root_location_id': 6001,
                                            'root_location_type': 'station', 'name': 'Box'}]}}
        with patch('portfolio_locations.station_details', return_value={'name': 'Station A'}):
            options = service._options(discovery)[1]
        self.assertEqual([r.get('kind') for r in options], ['station', 'container'])
        self.assertEqual(options[0]['key'], 'char:101:station:6001')
        self.assertEqual(options[1]['station_name'], 'Station A')

    def test_station_kind_is_saved_and_restored_offline(self):
        import portfolio_saved_sources
        station = dict(key='char:101:station:6001', character_id='101', item_id='6001',
                       name='Station A', path=['Pilot A', 'Station A'], location_id='6001',
                       root_location_id='6001', kind='station')
        wallet = dict(key='corp:1:division:1', corporation_id='1', division_id='1',
                      character_id='101', name='Division 1', label='Division 1')
        saved = {}
        with patch.object(service.migrations, 'migrate'), \
             patch.object(service, 'get_settings', return_value=dict(ok=True, divisions=[wallet], containers=[station])), \
             patch.object(service.repo, 'save_setting', side_effect=lambda k, v: saved.update({k: v})):
            self.assertTrue(service.save_settings(dict(wallet_source=wallet, asset_source=station))['ok'])
        with patch.object(portfolio_saved_sources.repo, 'get_settings', return_value=saved):
            _, restored, error = portfolio_saved_sources.load()
        self.assertIsNone(error)
        self.assertEqual(restored['kind'], 'station')
        self.assertEqual(restored['item_id'], '6001')
        import portfolio_market_history
        with patch.object(portfolio_market_history.repo, 'load_latest_assets', side_effect=AssertionError('station is already known')):
            self.assertEqual(portfolio_market_history.asset_station(restored), 6001)

if __name__ == '__main__': unittest.main()
