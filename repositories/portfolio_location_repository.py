#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Cache SQLite des lieux ESI publics, sans donnée utilisateur sensible."""
import time

import database as db


def get(location_id):
    with db.connection() as con:
        row = con.execute("SELECT * FROM portfolio_locations WHERE location_id=?",
                          (int(location_id),)).fetchone()
    if not row:
        return None
    data = dict(row)
    return {"location_id": data["location_id"],
            "solar_system_id": data["solar_system_id"],
            "constellation_id": data["constellation_id"],
            "region_id": data["region_id"], "name": data["location_name"],
            "npc_owner_id": data["npc_owner_id"],
            "is_npc": data["location_kind"] == "station"}


def upsert(details):
    row = dict(details)
    kind = "station" if row.get("is_npc") else "structure"
    params = (int(row["location_id"]), kind, str(row["name"]),
              row.get("solar_system_id"), row.get("constellation_id"),
              row.get("region_id"), row.get("npc_owner_id"),
              time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    sql = """INSERT INTO portfolio_locations VALUES (?,?,?,?,?,?,?,?)
             ON CONFLICT(location_id) DO UPDATE SET
             location_kind=excluded.location_kind,location_name=excluded.location_name,
             solar_system_id=excluded.solar_system_id,
             constellation_id=excluded.constellation_id,region_id=excluded.region_id,
             npc_owner_id=excluded.npc_owner_id,updated_at=excluded.updated_at"""
    return db.atomic(lambda con: con.execute(sql, params).rowcount)
