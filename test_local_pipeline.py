"""End-to-end clipboard failure/retry regression, without network or user data."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from eve_local_analyzer import LocalAnalyzer, LocalClipboardWatcher


class ClipboardPipelineTests(unittest.TestCase):
    def test_unconfirmed_identity_does_not_open_ui_and_same_list_can_be_retried(self):
        with tempfile.TemporaryDirectory() as directory:
            resolver = Mock(side_effect=[OSError('offline'), {'alpha pilot': 1, 'beta pilot': 2}])
            analyzer = LocalAnalyzer(Path(directory) / 'cache.json', resolve_ids=resolver,
                                     fetch_stats=lambda _: {}, resolve_names=lambda _: {})
            updates = []
            watcher = LocalClipboardWatcher(analyzer, updates.append,
                sequence=iter([1, 2]).__next__, read_text=lambda: 'Alpha Pilot\nBeta Pilot')
            watcher.poll_once()
            self.assertEqual(updates, [], 'Unconfirmed clipboard content must not activate the analyzer')
            self.assertTrue(watcher.last_error)
            watcher.poll_once()
            self.assertEqual(updates[-1]['state'], 'ready')
            self.assertEqual(resolver.call_count, 2)

    def test_manual_and_automatic_share_pipeline(self):
        with tempfile.TemporaryDirectory() as directory:
            analyzer = LocalAnalyzer(Path(directory) / 'cache.json',
                resolve_ids=lambda _: {'alpha pilot': 1, 'beta pilot': 2},
                fetch_stats=lambda _: {}, resolve_names=lambda _: {})
            updates = []
            watcher = LocalClipboardWatcher(analyzer, updates.append,
                sequence=lambda: 1, read_text=lambda: 'Alpha Pilot\nBeta Pilot')
            self.assertTrue(watcher.poll_once())
            updates.clear()
            self.assertTrue(watcher.analyze_now())
            self.assertEqual(updates[-1]['total'], 2)

if __name__ == '__main__':
    unittest.main()
