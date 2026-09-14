#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Résolution locale puis ESI des lieux, persistée pour les VM sans SDE."""
import mmd_esi as public_esi
import mmd_esi_orders as authenticated_esi
import mmd_stations as sde
import repositories.corporation_order_repository as order_repo
import repositories.portfolio_location_repository as location_repo
import repositories.portfolio_repository as repo


def station_details(location_id):
    """Résolution offline : SDE universel si présent, sinon dernier cache ESI."""
    try:
        location = int(location_id or 0)
    except (TypeError, ValueError):
        location = 0
    local = sde.station_details(location)
    if local.get("region_id") is not None:
        return local
    try:
        return location_repo.get(location) or local
    except Exception:
        return local


def _public(path):
    try:
        data, _cached = public_esi._get(
            f"{public_esi.ESI}{path}?datasource=tranquility")
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def _system_region(system_id):
    system = _public(f"/universe/systems/{int(system_id)}/")
    if not system or not system.get("constellation_id"):
        return None, None
    constellation_id = int(system["constellation_id"])
    constellation = _public(f"/universe/constellations/{constellation_id}/")
    region_id = int((constellation or {}).get("region_id") or 0) or None
    return constellation_id, region_id


def _station(location_id):
    data = _public(f"/universe/stations/{location_id}/")
    if not data or not data.get("system_id"):
        return None
    system_id = int(data["system_id"])
    constellation_id, region_id = _system_region(system_id)
    if not region_id:
        return None
    return {"location_id": location_id, "solar_system_id": system_id,
            "constellation_id": constellation_id, "region_id": region_id,
            "name": str(data.get("name") or location_id),
            "npc_owner_id": int(data.get("owner") or 0) or None,
            "is_npc": True}


def _structure(location_id, character_ids):
    info = None
    for character_id in character_ids:
        try:
            info = authenticated_esi.fetch_structure_info(
                location_id, character_id)
        except Exception:
            info = None
        if info:
            break
    if not info or not info.get("solarSystemID"):
        return None
    system_id = int(info["solarSystemID"])
    constellation_id, region_id = _system_region(system_id)
    if not region_id:
        return None
    return {"location_id": location_id, "solar_system_id": system_id,
            "constellation_id": constellation_id, "region_id": region_id,
            "name": str(info.get("name") or location_id),
            "npc_owner_id": None, "is_npc": False}


def refresh(location_ids, character_ids=(), max_locations=20):
    unresolved = sorted({int(value) for value in location_ids or ()
                         if int(value or 0) > 0 and
                         station_details(value).get("region_id") is None})
    limit = max(1, min(int(max_locations), 100))
    selected = unresolved[:limit]
    pending = max(0, len(unresolved) - limit)
    try:
        public_esi._load_cache()
    except Exception:
        pass
    failed = 0
    ids = list(dict.fromkeys(int(value) for value in character_ids or ()
                             if int(value or 0) > 0))
    for location_id in selected:
        details = (_station(location_id) if 60_000_000 <= location_id < 64_000_000
                   else _structure(location_id, ids) if location_id >= 10 ** 12
                   else None)
        if not details:
            failed += 1
            continue
        try:
            location_repo.upsert(details)
        except Exception:
            failed += 1
    return {"requested": len(selected), "pending": pending, "failed": failed}


def _asset_station(asset):
    if not asset:
        return None
    full = repo.load_latest_assets(int(asset["character_id"]), None)["items"]
    by_id = {int(row["item_id"]): row for row in full}
    target = by_id.get(int(asset["item_id"]))
    root = by_id.get(int((target or {}).get("root_container_id") or
                         (target or {}).get("item_id") or 0), target)
    return int((root or {}).get("location_id") or 0) or None


def refresh_current(wallet, asset, characters=()):
    corp, div = int(wallet["corporation_id"]), int(wallet["division_id"])
    orders = order_repo.load_orders(corp, div)
    transactions = repo.load_transactions("corporation", corp, div)
    location_ids = [row.get("location_id") for row in orders + transactions]
    location_ids.append(_asset_station(asset))
    preferred = [wallet.get("character_id"),
                 (asset or {}).get("character_id")]
    preferred.extend(row.get("id") for row in characters or ())
    return refresh(location_ids, preferred)
