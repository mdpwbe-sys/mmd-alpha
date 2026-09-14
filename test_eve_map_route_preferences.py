import json
from pathlib import Path
import tempfile
import unittest

from eve_map_route_preferences import EveMapRoutePreferences
from eve_map_service import EveMapService


SYSTEMS = [
    {"id": 1, "name": "A", "security": 1, "region_id": 10, "constellation_id": 100},
    {"id": 2, "name": "B", "security": 1, "region_id": 10, "constellation_id": 100},
    {"id": 3, "name": "C", "security": 1, "region_id": 20, "constellation_id": 200},
]


class EveMapRoutePreferencesTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.preferences = EveMapRoutePreferences(root / "preferences.json")
        dataset = root / "map.json"
        dataset.write_text(json.dumps({"systems": SYSTEMS, "gates": [{"source": 1, "target": 2}, {"source": 2, "target": 3}]}), encoding="utf-8")
        self.service = EveMapService(dataset)

    def tearDown(self):
        self.temporary.cleanup()

    def test_explicit_system_constellation_and_region_expand_to_systems(self):
        settings = self.preferences.configure({"entries": [
            {"kind": "system", "id": 1, "name": "A"},
            {"kind": "constellation", "id": 100, "name": "C100"},
            {"kind": "region", "id": 20, "name": "R20"},
        ]})
        self.assertEqual(3, len(settings["entries"]))
        self.assertEqual({1, 2, 3}, self.preferences.blocked_system_ids(SYSTEMS))

    def test_dynamic_incursion_needs_fresh_events_and_hotspot_is_local(self):
        self.preferences.configure({"avoid_incursions": True, "avoid_recent_hotspots": True})
        events = [{"type": "incursion", "system_id": 2}]
        hotspots = [{"system_id": 3}]
        self.assertEqual({3}, self.preferences.blocked_system_ids(SYSTEMS, world_events=events, hotspots=hotspots, world_events_live=False))
        self.assertEqual({2, 3}, self.preferences.blocked_system_ids(SYSTEMS, world_events=events, hotspots=hotspots, world_events_live=True))

    def test_route_excludes_the_expanded_system_but_preserves_existing_bfs(self):
        self.assertEqual([1, 2, 3], self.service.find_route(1, 3)["systems"])
        self.assertEqual("unreachable", self.service.find_route(1, 3, excluded_system_ids={2})["error"])
        self.assertEqual("avoided_endpoint", self.service.find_route(1, 3, excluded_system_ids={1})["error"])


if __name__ == "__main__":
    unittest.main()
