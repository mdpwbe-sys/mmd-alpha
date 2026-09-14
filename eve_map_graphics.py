"""Persistent, renderer-only quality choice for New Eden."""
from __future__ import annotations

import json
from pathlib import Path

from eve_map_runtime import graphics_settings_path


DEFAULT_SETTINGS = {"quality": "normal"}
_QUALITIES = frozenset(("off", "low", "normal"))


def _normalise(values: object) -> dict:
    value = values.get("quality") if isinstance(values, dict) else None
    return {"quality": str(value).lower() if str(value).lower() in _QUALITIES else "normal"}


class EveMapGraphicsSettings:
    """Small state file; deliberately contains no map or intel logic."""

    def __init__(self, path: Path | None = None):
        self.path = Path(path or graphics_settings_path())
        self._settings = self._read()

    def _read(self) -> dict:
        try:
            return _normalise(json.loads(self.path.read_text(encoding="utf-8")))
        except (OSError, TypeError, ValueError):
            return dict(DEFAULT_SETTINGS)

    def settings(self) -> dict:
        return dict(self._settings)

    def configure(self, values: object) -> dict:
        self._settings = _normalise({**self._settings, **(values if isinstance(values, dict) else {})})
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.path.with_suffix(".tmp")
            temporary.write_text(json.dumps(self._settings, separators=(",", ":")), encoding="utf-8")
            temporary.replace(self.path)
        except OSError:
            pass
        return self.settings()
