import unittest
from unittest.mock import patch
import mmd_stations as stations

class MissingSdeTests(unittest.TestCase):
    def test_fresh_install_returns_unknown_instead_of_sqlite_crash(self):
        with patch.object(stations,'EVE_DB','/missing/mmd/eve.db'), \
             patch.object(stations,'_sys_cache',{}), \
             patch.object(stations,'_runtime_structures',{}), \
             patch.object(stations,'_ENV_STATIONS',None), \
             patch.object(stations,'_jumps',None):
            system,region,name=stations.resolve(60008494)
            self.assertIsNone(system)
            self.assertIsNone(region)
            self.assertEqual(name,'60008494')
            self.assertIsNone(stations.system_region(30000142))
            stations._load_jumps()
            self.assertEqual(stations._jumps,{})
