"""Private MMD environment adapter for New Eden modules only."""
import os
from pathlib import Path

import mmd_esi as esi
import mmd_esi_auth as esi_auth
import mmd_sso as sso


def map_cache_path() -> Path:
    appdata = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    return appdata / "MMD-Trader" / "cache" / "eve_map_intel.json"


def traffic_snapshot_dir() -> Path:
    """Bounded raw ESI system-jump observations for experimental Traffic V3."""
    return map_cache_path().parent / "traffic_snapshots"


def local_intel_cache_path() -> Path:
    """Persistent Local Analyzer cache, outside a PyInstaller temp directory."""
    appdata = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    return appdata / "MMD-Trader" / "cache" / "local_intel.json"


def intel_alert_settings_path() -> Path:
    """Persistent New Eden proximity-alert preferences."""
    appdata = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    return appdata / "MMD-Trader" / "cache" / "eve_map_intel_alert.json"


def graphics_settings_path() -> Path:
    """Persistent renderer-only New Eden graphics preference."""
    appdata = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    return appdata / "MMD-Trader" / "cache" / "eve_map_graphics.json"


def route_preferences_path() -> Path:
    """Persistent local routing preferences; never part of an ESI request."""
    appdata = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    return appdata / "MMD-Trader" / "cache" / "eve_map_route_preferences.json"
