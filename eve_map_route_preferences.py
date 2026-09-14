"""Persistent, local New Eden route avoidance preferences."""
from __future__ import annotations

import json
from pathlib import Path

from eve_map_runtime import route_preferences_path


DEFAULT_SETTINGS = {
    "entries": [],
    "avoid_incursions": False,
    "avoid_recent_hotspots": False,
}
_KINDS = frozenset(("system", "constellation", "region"))


def _normalise(values: object) -> dict:
    values = values if isinstance(values, dict) else {}
    entries, seen = [], set()
    for row in values.get("entries", []):
        if not isinstance(row, dict):
            continue
        kind = str(row.get("kind") or "").lower()
        try:
            identifier = int(row.get("id"))
        except (TypeError, ValueError):
            continue
        if kind not in _KINDS or identifier <= 0 or (kind, identifier) in seen:
            continue
        seen.add((kind, identifier))
        entries.append({"kind": kind, "id": identifier, "name": str(row.get("name") or identifier)[:120]})
    return {
        "entries": entries,
        "avoid_incursions": bool(values.get("avoid_incursions", False)),
        "avoid_recent_hotspots": bool(values.get("avoid_recent_hotspots", False)),
    }


class EveMapRoutePreferences:
    """Small interface for persisted rules and their expansion to system IDs."""

    def __init__(self, path: Path | None = None):
        self.path = Path(path or route_preferences_path())
        self._settings = self._read()

    def _read(self) -> dict:
        try:
            return _normalise(json.loads(self.path.read_text(encoding="utf-8")))
        except (OSError, TypeError, ValueError):
            return dict(DEFAULT_SETTINGS)

    def settings(self) -> dict:
        return {**self._settings, "entries": [dict(row) for row in self._settings["entries"]]}

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

    def blocked_system_ids(self, systems, *, world_events=(), hotspots=(), world_events_live=False) -> set[int]:
        blocked = set()
        entries = {(row["kind"], row["id"]) for row in self._settings["entries"]}
        for system in systems or ():
            try:
                system_id = int(system["id"])
            except (TypeError, ValueError, KeyError):
                continue
            if (("system", system_id) in entries or
                    ("constellation", int(system.get("constellation_id") or 0)) in entries or
                    ("region", int(system.get("region_id") or 0)) in entries):
                blocked.add(system_id)
        if self._settings["avoid_incursions"] and world_events_live:
            blocked.update(
                int(row.get("system_id")) for row in world_events or ()
                if str(row.get("type")) == "incursion" and str(row.get("system_id") or "").isdigit()
            )
        if self._settings["avoid_recent_hotspots"]:
            blocked.update(
                int(row.get("system_id")) for row in hotspots or ()
                if str(row.get("system_id") or "").isdigit()
            )
        return blocked
