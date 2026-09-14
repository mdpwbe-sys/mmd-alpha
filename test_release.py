import unittest
from pathlib import Path
import build_exe
from tools.audit_release import audit


class ReleaseTests(unittest.TestCase):
    def test_no_private_files_or_missing_ui_bridge(self):
        result = audit()
        self.assertTrue(result['ok'],result['findings'])

    def test_build_assets_exclude_runtime_and_tests(self):
        assets = build_exe.asset_files()
        self.assertTrue(assets)
        self.assertTrue(any(p.name=='sde_setup.js' for p in assets))
        for path in assets:
            self.assertNotIn('.test.',path.name)
            self.assertNotIn('reference',path.parts)
            self.assertNotEqual(path.suffix,'.json')
        self.assertFalse(Path('eve_gate_traffic_v3.py').exists())
