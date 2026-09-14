#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Preuve persistante qu'une source portefeuille vide a réellement réussi."""
import time

import database as db


def _now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _scope(source, owner_kind, owner_id, division_id=0):
    source, kind = str(source), str(owner_kind)
    oid, div = int(owner_id), int(division_id)
    if not source or kind not in ("character", "corporation") or oid <= 0:
        raise ValueError("scope sync portefeuille invalide")
    if not 0 <= div <= 7 or (kind == "character" and div != 0):
        raise ValueError("division sync portefeuille invalide")
    return source, kind, oid, div


def mark_success(source, owner_kind, owner_id, division_id, count):
    scope, at, total = _scope(source, owner_kind, owner_id, division_id), _now(), int(count)
    if total < 0:
        raise ValueError("compteur sync invalide")
    sql = """INSERT INTO portfolio_sync_state VALUES (?,?,?,?,?,'success',?,?,NULL,NULL,NULL)
             ON CONFLICT(source,owner_kind,owner_id,division_id) DO UPDATE SET
             last_attempt_at=excluded.last_attempt_at,last_attempt_status='success',
             last_success_at=excluded.last_success_at,last_success_count=excluded.last_success_count,
             error_kind=NULL,error_status=NULL,error_message=NULL"""
    return db.atomic(lambda con: con.execute(sql, (*scope, at, at, total)).rowcount)


def mark_failure(source, owner_kind, owner_id, division_id, error):
    scope, at = _scope(source, owner_kind, owner_id, division_id), _now()
    err = error if isinstance(error, dict) else {}
    kind = err.get("kind") or type(error).__name__
    status = err.get("status")
    message = err.get("message") or str(error)
    sql = """INSERT INTO portfolio_sync_state VALUES (?,?,?,?,?,'error',NULL,NULL,?,?,?)
             ON CONFLICT(source,owner_kind,owner_id,division_id) DO UPDATE SET
             last_attempt_at=excluded.last_attempt_at,last_attempt_status='error',
             error_kind=excluded.error_kind,error_status=excluded.error_status,
             error_message=excluded.error_message"""
    return db.atomic(lambda con: con.execute(
        sql, (*scope, at, str(kind), int(status) if status is not None else None,
              str(message))).rowcount)


def get_state(source, owner_kind, owner_id, division_id=0):
    scope = _scope(source, owner_kind, owner_id, division_id)
    with db.connection() as con:
        row = con.execute("SELECT * FROM portfolio_sync_state WHERE source=? AND "
                          "owner_kind=? AND owner_id=? AND division_id=?", scope).fetchone()
    return dict(row) if row else None
