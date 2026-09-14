"""Real tail/parser/cache/Intel integration with isolated UTF-16 chat fixtures."""
from datetime import datetime, timezone
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from eve_tracked_positions import TrackedPositions
from eve_local_watchdog import LocalChatWatchdog, FloodDetector, repeat_ratio
from eve_map_intel_alert import EveMapIntelAlert
from mmd_gui import local_chatlog_jump_character_id


class Map:
    systems = [{'id': 1, 'name': 'Jita'}, {'id': 2, 'name': 'Perimeter'}, {'id': 3, 'name': 'Tama'}]
    def get_map_data(self): return {'systems': self.systems}
    def get_system(self, sid): return next((s for s in self.systems if s['id'] == sid), None)
    def systems_within_jumps(self, sid, radius):
        return {s['id']: abs(s['id'] - sid) for s in self.systems if abs(s['id'] - sid) <= radius}


class TrackingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.clock = [datetime(2026, 9, 5, tzinfo=timezone.utc).timestamp()]
        self.fetch = Mock(return_value=1)
        self.store = TrackedPositions(map_service=Map(), characters=lambda: [{'id': 101, 'name': 'Alpha'}, {'id': 102, 'name': 'Beta'}],
                                      fetch_location=self.fetch, now=lambda: self.clock[0])
        self.events = []
        self.store.subscribe(self.events.append)
        self.watcher = LocalChatWatchdog(self.store, directory=self.root,
            settings_path=self.root / 'settings.json', now=lambda: self.clock[0], active_clients=lambda: {'alpha', 'beta'})

    def stamp(self): return datetime.fromtimestamp(self.clock[0], timezone.utc).strftime('%Y.%m.%d %H:%M:%S')

    def log(self, name='Alpha', cid=101, system='Jita'):
        path = self.root / f'Local_20260905_000000_{cid}.txt'
        path.write_text(f'Channel ID: local\nListener: {name}\nSession started: {self.stamp()}\n'
                        f'\ufeff[ {self.stamp()} ] EVE System > Channel changed to Local : {system}\n', encoding='utf-16')
        return path

    def append(self, path, sender, message):
        with path.open('ab') as target:
            target.write(f'[ {self.stamp()} ] {sender} > {message}\n'.encode('utf-16-le'))

    def test_fresh_local_does_not_fetch_location_for_that_pilot(self):
        self.log()
        self.watcher.poll_once()
        response = self.store.refresh()
        self.assertEqual(self.fetch.call_args_list[0].args, (102,))
        self.assertEqual(response['positions'][0]['source'], 'LOCAL_CHATLOG')
        self.assertTrue(response['positions'][0]['local_confirmed'])

    def test_jump_publishes_and_recomputes_intel_immediately(self):
        alert = EveMapIntelAlert(settings_path=self.root / 'intel.json', map_service=Map(), now=lambda: self.clock[0])
        alert._settings.update(enabled=True, radius_jumps=0)
        alert.position_snapshot = self.store.snapshot
        self.store.subscribe(alert.update_positions)
        path = self.log()
        self.watcher.poll_once()
        self.assertIsNotNone(alert.on_marker({'killmail_id': 1, 'system_id': 1}))
        self.clock[0] += 1
        self.append(path, 'EVE System', 'Channel changed to Local : Perimeter')
        self.watcher.poll_once()
        self.assertEqual(self.store.snapshot()['positions'][0]['system_id'], 2)
        self.assertIsNone(alert.on_marker({'killmail_id': 2, 'system_id': 1}))
        self.assertEqual(alert.on_marker({'killmail_id': 3, 'system_id': 2})['distance_jumps'], 0)
        self.fetch.assert_not_called()

    def test_confirmed_local_jump_selects_that_pilot_without_initial_log_hijack(self):
        rows = [{'character_id': 101, 'system_id': 1, 'source': 'LOCAL_CHATLOG'}]
        self.assertIsNone(local_chatlog_jump_character_id({}, rows))
        self.assertEqual(local_chatlog_jump_character_id({101: (1, 'LOCAL_CHATLOG')}, [
            {'character_id': 101, 'system_id': 2, 'source': 'LOCAL_CHATLOG'},
        ]), 101)
        self.assertIsNone(local_chatlog_jump_character_id({101: (1, 'ESI')}, rows))

    def test_stale_local_falls_back_and_cannot_generate_sound_event(self):
        self.log()
        self.watcher.poll_once()
        alert = EveMapIntelAlert(settings_path=self.root / 'intel.json', map_service=Map(), now=lambda: self.clock[0])
        alert._settings.update(enabled=True)
        alert.position_snapshot = self.store.snapshot
        self.store.subscribe(alert.update_positions)
        alert.update_positions(self.store.snapshot())
        self.clock[0] += 31
        self.assertIsNone(alert.on_marker({'killmail_id': 1, 'system_id': 1}))
        self.store.refresh()
        self.assertEqual(self.store.snapshot()['positions'][0]['source'], 'ESI')
        self.assertIsNone(alert.on_marker({'killmail_id': 2, 'system_id': 1}))

    def test_two_clients_and_no_refetch_on_repoll(self):
        self.log()
        self.log('Beta', 102, 'Perimeter')
        self.watcher.poll_once()
        self.assertEqual([(r['character_id'], r['system_id']) for r in self.store.snapshot()['positions']], [(101, 1), (102, 2)])
        self.assertFalse(self.store.observe_local(
            character_id=999, character_name='Unknown', system_name='Jita',
            observed_at=self.clock[0], session_source='untracked', session_started=self.clock[0]))
        events = len(self.events)
        self.watcher.poll_once()
        self.store.refresh()
        self.assertEqual(len(self.events), events)
        self.fetch.assert_not_called()

    def test_unknown_and_malformed_log_cannot_corrupt_position(self):
        path = self.log()
        self.watcher.poll_once()
        self.append(path, 'Fake Pilot', 'Channel changed to Local : Tama')
        self.append(path, 'EVE System', 'Channel changed to Local : Not a system')
        with path.open('ab') as target:
            target.write(b'broken')
        self.watcher.poll_once()
        self.assertEqual(self.store.snapshot()['positions'][0]['system_id'], 1)
        self.clock[0] += 31
        self.store.refresh()
        self.assertEqual(self.store.snapshot()['positions'][0]['source'], 'ESI')

    def test_late_esi_does_not_overwrite_local(self):
        def delayed(cid):
            if cid == 101:
                self.store.observe_local(character_id=101, character_name='Alpha', system_name='Perimeter',
                    observed_at=self.clock[0], session_source='new', session_started=self.clock[0])
            return 1
        self.fetch.side_effect = delayed
        self.store.refresh()
        self.assertEqual(self.store.snapshot()['positions'][0]['system_id'], 2)

    def test_old_session_cannot_overwrite_new(self):
        now = self.clock[0]
        self.assertTrue(self.store.observe_local(character_id=101, character_name='Alpha', system_name='Perimeter',
            observed_at=now, session_source='new', session_started=now))
        self.assertFalse(self.store.observe_local(character_id=101, character_name='Alpha', system_name='Jita',
            observed_at=now, session_source='old', session_started=now - 50))

    def test_no_running_client_means_no_local_confirmation(self):
        self.log()
        self.watcher.active_clients = lambda: set()
        self.watcher.poll_once()
        self.assertEqual(self.store.snapshot()['positions'], [])

    def test_incremental_utf16_partial_line_and_rotation(self):
        path = self.log()
        self.watcher.poll_once()
        row = f'[ {self.stamp()} ] EVE System > Channel changed to Local : Perimeter\n'.encode('utf-16-le')
        with path.open('ab') as target: target.write(row[:-3])
        self.watcher.poll_once()
        self.assertEqual(self.store.snapshot()['positions'][0]['system_id'], 1)
        with path.open('ab') as target: target.write(row[-3:])
        self.watcher.poll_once()
        self.assertEqual(self.store.snapshot()['positions'][0]['system_id'], 2)
        before = len(self.events)
        path.unlink()
        self.log(system='Perimeter')
        self.watcher.poll_once()
        self.assertEqual(len(self.events), before)

    def test_settings_persist_without_database(self):
        self.watcher.configure({'enabled': True, 'threshold': 8, 'duration': 3})
        other = LocalChatWatchdog(self.store, directory=self.root, settings_path=self.root / 'settings.json')
        self.assertEqual(other.settings()['threshold'], 8)

    def test_system_lines_are_not_counted_as_players(self):
        self.watcher.configure({'enabled': True})
        path = self.log()
        self.append(path, 'EVE System', 'Some notification')
        self.append(path, 'Trader', 'Sell item')
        self.watcher.poll_once()
        self.assertEqual(set(self.watcher.flood.senders), {'trader'})
        self.assertEqual(len(self.watcher.flood.senders['trader']['events']), 1)


class FloodTests(unittest.TestCase):
    def feed(self, detector, rate, minutes, start=0, name='Pilot'):
        result = []
        for minute in range(minutes):
            for i in range(rate): detector.add(name, ' Buy  123 https://example.invalid/123 ', start + minute * 60 + i)
            result.extend(detector.evaluate(start + (minute + 1) * 60))
        return result

    def test_five_per_minute_five_minutes_alerts_at_configured_threshold(self):
        self.assertEqual(len(self.feed(FloodDetector(), 5, 5)), 1)

    def test_two_messages_in_one_rolling_minute_alert_immediately_at_sensitive_setting(self):
        detector = FloodDetector({'enabled': True, 'threshold': 2, 'duration': 1, 'cooldown': 1})
        detector.add('Spammer', 'first', 0)
        detector.add('Spammer', 'second', 1)
        result = detector.evaluate(2)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]['sender'], 'Spammer')
        self.assertEqual(result[0]['count'], 2)

    def test_six_per_minute_four_minutes_none(self):
        self.assertEqual(self.feed(FloodDetector(), 6, 4), [])

    def test_six_per_minute_five_minutes_one(self):
        result = self.feed(FloodDetector(), 6, 5)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]['count'], 30)

    def test_burst_then_silence_none(self):
        detector = FloodDetector()
        for second in range(30): detector.add('Burst', 'message', second)
        self.assertFalse(detector.evaluate(300))

    def test_sustained_flood_no_repeat_after_cooldown_until_rearmed(self):
        detector = FloodDetector()
        self.assertEqual(len(self.feed(detector, 6, 25)), 1)
        for now in range(1560, 2101, 60): detector.evaluate(now)
        self.assertEqual(len(self.feed(detector, 6, 5, start=2100)), 1)

    def test_senders_independent(self):
        detector = FloodDetector()
        for minute in range(5):
            for sender in ['One', 'Two']:
                for i in range(6): detector.add(sender, 'text', minute * 60 + i)
        self.assertEqual(len(detector.evaluate(300)), 2)

    def test_repeat_normalizes_urls_numbers_and_spaces(self):
        self.assertEqual(repeat_ratio(['Buy  123 https://x/1', 'buy 456 https://y/2', ' BUY 789 https://z/3']), 67)

if __name__ == '__main__': unittest.main()
