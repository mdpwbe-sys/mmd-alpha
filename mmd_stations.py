#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
mmd_stations.py - resolution location_id -> (solarSystemID, regionID, name)
+ graphe de sauts SDE pour le moteur de portee des BUY orders.

Deux sources:
  - staStations (stations NPC) -> solarSystemID direct
  - .env: Trading_Upwell_ID / Sell_Station_ID -> on mappe l'ID de structure
    vers le systeme grace au nom (ex: 'Perimeter' -> mapSolarSystems)
  - fallback: si inconnu, on garde l'ID brut (nom = str(id))

La portee BUY est normalisee ici, une seule fois. Une portee absente ou
inconnue est volontairement rejetee: elle ne devient jamais regionale.
"""
import logging
from platform_state import state_path
import os, sqlite3, json
from contextlib import closing

LOCAL = os.environ.get("LOCALAPPDATA", os.path.expanduser("~\\AppData\\Local"))
from eve_sde import DatabasePath
EVE_DB = DatabasePath()
HERE = os.path.dirname(os.path.abspath(__file__))
ENV = state_path(".env")

# cache resolution
_sys_cache = {}
_region_cache = {}
_runtime_structures = {}
_jumps = None  # dict fromSystem -> set(toSystem)
_LOG = logging.getLogger(__name__)
_INVALID_BUY_RANGES_LOGGED = set()


def _load_env_stations():
    """Mappe les structures du .env vers (location_id, systeme, nom)."""
    out = {}
    if not os.path.exists(ENV) or not os.path.isfile(EVE_DB):
        return out
    cfg = {}
    with open(ENV, encoding="utf-8") as env_file:
        for line in env_file:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            cfg[k.strip()] = v.strip()
    import sqlite3 as sq
    c = sq.connect(EVE_DB)
    # Trading_Upwell_ID=35833//1044752365771  + Trading_Upwell_NAME=Perimeter ...
    if "Trading_Upwell_ID" in cfg and "Trading_Upwell_NAME" in cfg:
        loc = int(cfg["Trading_Upwell_ID"].split("//")[-1])
        name = cfg["Trading_Upwell_NAME"]
        sysid = _system_from_name(c, name)
        out[loc] = {"solarSystemID": sysid, "name": name}
    if "Sell_Station_ID" in cfg and "Sell_Station_NAME" in cfg:
        loc = int(cfg["Sell_Station_ID"].split("//")[-1])
        name = cfg["Sell_Station_NAME"]
        sysid = _system_from_name(c, name)
        out[loc] = {"solarSystemID": sysid, "name": name}
    c.close()
    return out


def _system_from_name(c, name):
    """Trouve le solarSystemID a partir du nom de station (ex: 'Perimeter')."""
    # prend le 1er mot significatif du nom de la structure
    token = name.split()[0].strip("-,.")
    try:
        r = c.execute("SELECT solarSystemID FROM mapSolarSystems WHERE solarSystemName LIKE ?",
                      (f"%{token}%",)).fetchone()
        return r[0] if r else None
    except Exception:
        return None


_ENV_STATIONS = None


def _env_stations():
    global _ENV_STATIONS
    if _ENV_STATIONS is None:
        _ENV_STATIONS = _load_env_stations()
    return _ENV_STATIONS


def _configured_trading_upwell_id():
    """Return the configured buy Upwell ID without baking a structure into code."""
    try:
        with open(ENV, encoding="utf-8") as env_file:
            for line in env_file:
                if line.strip().startswith("Trading_Upwell_ID="):
                    return int(line.split("=", 1)[1].strip().split("//")[-1])
    except Exception:
        pass
    return None


def buy_hub_priority(location_id):
    """BUY tie-break hub priority: Jita before the configured Perimeter Upwell."""
    try:
        location_id = int(location_id)
    except (TypeError, ValueError):
        return 0
    if location_id == 60003760:
        return 2
    return 1 if location_id == _configured_trading_upwell_id() else 0


def _region_for_system(solar_system_id):
    try:
        with closing(sqlite3.connect(EVE_DB)) as con:
            row = con.execute("SELECT regionID FROM mapSolarSystems WHERE solarSystemID=?",
                              (int(solar_system_id),)).fetchone()
        return int(row[0]) if row and row[0] is not None else None
    except Exception:
        return None


def register_structure(structure_id, solar_system_id, *, name=""):
    """Cache an accessible Upwell structure with its authoritative ESI system."""
    try:
        structure_id, solar_system_id = int(structure_id), int(solar_system_id)
    except (TypeError, ValueError):
        return None
    if structure_id <= 0 or solar_system_id <= 0:
        return None
    region_id = _region_for_system(solar_system_id)
    if region_id is None:
        return None
    resolved = (solar_system_id, region_id, str(name or structure_id))
    _runtime_structures[structure_id] = resolved
    _sys_cache[structure_id] = resolved
    return resolved


def resolve_name(location_id, fallback=""):
    """Retourne le nom lisible de la station (station NPC ou Upwell)."""
    loc_id = int(location_id or 0)
    if not loc_id:
        return fallback or "Inconnu"
    runtime = _runtime_structures.get(loc_id)
    if runtime and runtime[2]:
        return runtime[2]
    if loc_id == 60003760:
        return "Jita IV - Moon 4 - Caldari Navy Assembly Plant"
    try:
        c = sqlite3.connect(EVE_DB)
        r = c.execute("SELECT stationName FROM staStations WHERE stationID=?", (loc_id,)).fetchone()
        c.close()
        if r and r[0]:
            return r[0]
    except Exception:
        pass
    env = _env_stations()
    if loc_id in env and env[loc_id].get("name"):
        return env[loc_id]["name"]
    return fallback or str(loc_id)


def resolve(location_id):
    """Retourne (solarSystemID, regionID, name) pour un location_id.
    None si inconnu."""
    try:
        location_id = int(location_id)
    except (TypeError, ValueError):
        return None, None, resolve_name(location_id, str(location_id))
    if location_id in _runtime_structures:
        return _runtime_structures[location_id]
    if location_id in _sys_cache:
        return _sys_cache[location_id]
    if not os.path.isfile(EVE_DB):
        return None, None, resolve_name(location_id, str(location_id))
    c = sqlite3.connect(EVE_DB)
    # 1. station NPC
    try:
        r = c.execute("SELECT solarSystemID, stationName FROM staStations WHERE stationID=?",
                      (location_id,)).fetchone()
        if r and r[0]:
            s = r[0]
            st_name = r[1] if (len(r) > 1 and r[1]) else None
            r2 = c.execute("SELECT regionID, solarSystemName FROM mapSolarSystems WHERE solarSystemID=?",
                           (s,)).fetchone()
            name = st_name or (r2[1] if r2 else str(location_id))
            res = (s, r2[0] if r2 else None, name)
            _sys_cache[location_id] = res
            c.close()
            return res
    except Exception:
        pass
    # 2. structure du .env
    env = _env_stations()
    if location_id in env:
        sysid = env[location_id]["solarSystemID"]
        region = None
        if sysid:
            r3 = c.execute("SELECT regionID FROM mapSolarSystems WHERE solarSystemID=?",
                           (sysid,)).fetchone()
            region = r3[0] if r3 else None
        res = (sysid, region, env[location_id]["name"])
        _sys_cache[location_id] = res
        c.close()
        return res
    c.close()
    _sys_cache[location_id] = (None, None, resolve_name(location_id, str(location_id)))
    return _sys_cache[location_id]


def station_details(location_id):
    """Métadonnées SDE génériques d'une station NPC, sans alias de hub."""
    location_id = int(location_id or 0)
    if not location_id or not os.path.isfile(EVE_DB):
        return {"location_id": location_id, "solar_system_id": None,
                "region_id": None, "name": str(location_id or "Inconnu"),
                "npc_owner_id": None, "is_npc": False}
    system_id, region_id, name = resolve(location_id)
    owner_id = None
    try:
        with closing(sqlite3.connect(EVE_DB)) as con:
            row = con.execute("SELECT corporationID,solarSystemID,regionID,stationName "
                              "FROM staStations WHERE stationID=?",
                              (location_id,)).fetchone()
        if row:
            owner_id, system_id, region_id, name = row
    except Exception:
        pass
    return {"location_id": location_id, "solar_system_id": system_id,
            "region_id": region_id, "name": name or str(location_id),
            "npc_owner_id": owner_id, "is_npc": owner_id is not None}


def _load_jumps():
    global _jumps
    if _jumps is not None:
        return
    if not os.path.isfile(EVE_DB):
        _jumps = {}
        return
    c = sqlite3.connect(EVE_DB)
    _jumps = {}
    for frm, to in c.execute("SELECT fromSolarSystemID, toSolarSystemID FROM mapSolarSystemJumps"):
        _jumps.setdefault(frm, set()).add(to)
    c.close()


def system_region(system_id):
    if not os.path.isfile(EVE_DB):
        return None
    if system_id in _region_cache:
        return _region_cache[system_id]
    c = sqlite3.connect(EVE_DB)
    r = c.execute("SELECT regionID FROM mapSolarSystems WHERE solarSystemID=?",
                  (system_id,)).fetchone()
    c.close()
    reg = r[0] if r else None
    _region_cache[system_id] = reg
    return reg


def jumps_bfs(start, max_depth):
    """Ensemble des systemes a <= max_depth sauts de start (BFS)."""
    if start is None:
        return set()
    _load_jumps()
    seen = {start}
    frontier = {start}
    for _ in range(max_depth):
        nxt = set()
        for s in frontier:
            for t in _jumps.get(s, ()):
                if t not in seen:
                    seen.add(t)
                    nxt.add(t)
        frontier = nxt
    return seen


def _invalid_buy_range(value):
    key = repr(value)
    if key not in _INVALID_BUY_RANGES_LOGGED:
        _INVALID_BUY_RANGES_LOGGED.add(key)
        _LOG.warning("BUY range invalid or missing; ignoring order conservatively: %r", value)
    return None


def normalize_buy_range(value):
    """Return canonical (kind, jump_count) or ``None`` for an unsafe range.

    CCP/ESI sends station, solarsystem and region as words, and jump ranges as
    numeric strings or integers.  Unknown values are deliberately not widened.
    """
    if isinstance(value, bool) or value is None:
        return _invalid_buy_range(value)
    if isinstance(value, int):
        # EVE market logs use enum values whereas ESI uses words.
        legacy = {-1: ("STATION", None), 0: ("SYSTEM", None),
                  32767: ("REGION", None)}
        if value in legacy:
            return legacy[value]
        return ("JUMPS", value) if value > 0 else _invalid_buy_range(value)
    if not isinstance(value, str):
        return _invalid_buy_range(value)
    normalized = value.strip().lower().replace("-", "_").replace(" ", "_")
    if normalized == "station":
        return ("STATION", None)
    if normalized in {"solar_system", "solarsystem"}:
        return ("SYSTEM", None)
    if normalized == "region":
        return ("REGION", None)
    try:
        jumps = int(normalized)
    except ValueError:
        return _invalid_buy_range(value)
    legacy = {-1: ("STATION", None), 0: ("SYSTEM", None),
              32767: ("REGION", None)}
    if jumps in legacy:
        return legacy[jumps]
    return ("JUMPS", jumps) if jumps > 0 else _invalid_buy_range(value)


def covers(pub_order_location, pub_order_range, target_system, target_region, target_location=None):
    """True si un ordre public (location+range) couvre la station cible.
    - target_system/target_region: resolution de MA station
    - target_location: station/structure target when a Station range is tested.
    - pub_order_range: canonicalised ESI/MMD range.
    """
    if target_region is None or target_system is None:
        return False
    normalized = normalize_buy_range(pub_order_range)
    if normalized is None:
        return False
    pub_sys, pub_reg, _ = resolve(pub_order_location)
    kind, jump_count = normalized
    if kind == "STATION":
        return target_location is not None and int(pub_order_location) == int(target_location)
    if kind == "SYSTEM":
        return pub_sys == target_system
    if kind == "REGION":
        return pub_reg == target_region
    return target_system in jumps_bfs(pub_sys, jump_count)


def _order_location_id(order):
    return order.get("location_id", order.get("station_id"))


def _covered_systems(location_id, normalized, system_id):
    kind, jump_count = normalized
    if kind == "SYSTEM":
        return {system_id}
    if kind == "JUMPS":
        return jumps_bfs(system_id, jump_count)
    return None


def buy_ranges_overlap(my_order, competitor):
    """Whether two BUY ranges can target at least one common sale location."""
    my_location, competitor_location = _order_location_id(my_order), _order_location_id(competitor)
    if my_location is None or competitor_location is None:
        return False
    my_range, competitor_range = normalize_buy_range(my_order.get("range")), normalize_buy_range(competitor.get("range"))
    if my_range is None or competitor_range is None:
        return False
    my_system, my_region, _ = resolve(my_location)
    competitor_system, competitor_region, _ = resolve(competitor_location)
    if my_system is None or competitor_system is None:
        return False
    my_kind, competitor_kind = my_range[0], competitor_range[0]
    if my_kind == "REGION" or competitor_kind == "REGION":
        return my_region is not None and my_region == competitor_region
    if my_kind == "STATION":
        return covers(competitor_location, competitor.get("range"), my_system, my_region, my_location)
    if competitor_kind == "STATION":
        return covers(my_location, my_order.get("range"), competitor_system, competitor_region, competitor_location)
    return bool(_covered_systems(my_location, my_range, my_system) &
                _covered_systems(competitor_location, competitor_range, competitor_system))
