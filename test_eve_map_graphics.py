import json
import tempfile
import unittest
from pathlib import Path

from eve_map_graphics import EveMapGraphicsSettings


class EveMapGraphicsSettingsTests(unittest.TestCase):
    def test_off_persists_and_switches_back(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "graphics.json"
            settings = EveMapGraphicsSettings(path)
            self.assertEqual(settings.configure({"quality": "OFF"}), {"quality": "off"})
            self.assertEqual(EveMapGraphicsSettings(path).settings(), {"quality": "off"})
            for quality in ("low", "normal", "off"):
                self.assertEqual(settings.configure({"quality": quality}), {"quality": quality})

    def test_normal_is_the_default_and_invalid_values_do_not_change_it(self):
        with tempfile.TemporaryDirectory() as directory:
            settings = EveMapGraphicsSettings(Path(directory) / "eve_map_graphics.json")
            self.assertEqual(settings.settings(), {"quality": "normal"})
            self.assertEqual(settings.configure({"quality": "ultra"}), {"quality": "normal"})

    def test_low_persists_and_can_return_to_normal(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "eve_map_graphics.json"
            settings = EveMapGraphicsSettings(path)
            self.assertEqual(settings.configure({"quality": "LOW"}), {"quality": "low"})
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), {"quality": "low"})
            self.assertEqual(EveMapGraphicsSettings(path).settings(), {"quality": "low"})
            self.assertEqual(settings.configure({"quality": "normal"}), {"quality": "normal"})


if __name__ == "__main__":
    unittest.main()
