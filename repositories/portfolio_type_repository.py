#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Cache SQLite des noms de types ESI publics."""
import time

import database as db


def get_name(type_id):
    with db.connection() as con:
        row = con.execute("SELECT type_name FROM portfolio_type_names WHERE type_id=?",
                          (int(type_id),)).fetchone()
    return str(row["type_name"]) if row else None


def upsert(type_id, name):
    params = (int(type_id), str(name),
              time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    sql = """INSERT INTO portfolio_type_names VALUES (?,?,?)
             ON CONFLICT(type_id) DO UPDATE SET
             type_name=excluded.type_name,updated_at=excluded.updated_at"""
    return db.atomic(lambda con: con.execute(sql, params).rowcount)
