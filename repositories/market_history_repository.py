#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Écriture exacte de l'historique marché régional ESI."""
import database as db
import mmd_price as price


def _cents(row, cents_key, value_key):
    value = row.get(cents_key)
    return int(value) if value is not None else price.to_cents(row[value_key])


def upsert(region_id, type_id, rows):
    region, tid = int(region_id), int(type_id)
    params = [(region, tid, str(row["date"]), _cents(row, "avg_cents", "average"),
               _cents(row, "high_cents", "highest"), _cents(row, "low_cents", "lowest"),
               int(row.get("volume") or 0), int(row.get("order_count") or 0))
              for row in rows or ()]
    sql = "INSERT OR REPLACE INTO historical_market_daily VALUES (?,?,?,?,?,?,?,?)"
    return db.atomic(lambda con: con.executemany(sql, params).rowcount) if params else 0
