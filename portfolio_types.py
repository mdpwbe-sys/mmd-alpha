#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Noms de types via SDE local puis cache ESI public pour VM propre."""
from concurrent.futures import ThreadPoolExecutor

import mmd_core as core
import mmd_esi as public_esi
import portfolio_asset_selection as asset_selection
import repositories.corporation_order_repository as order_repo
import repositories.portfolio_repository as repo
import repositories.portfolio_type_repository as type_repo


def item_name(type_id):
    tid = int(type_id)
    fallback = f"Item #{tid}"
    local = core.iname(tid)
    if local != fallback:
        return local
    try:
        return type_repo.get_name(tid) or fallback
    except Exception:
        return fallback


def _fetch(type_id):
    url = (f"{public_esi.ESI}/universe/types/{type_id}/"
           "?datasource=tranquility")
    try:
        data, _cached = public_esi._get(url)
        name = str((data or {}).get("name") or "").strip()
        return type_id, name or None
    except Exception:
        return type_id, None


def refresh(type_ids, max_types=40):
    unresolved = sorted({int(value) for value in type_ids or ()
                         if int(value or 0) > 0 and
                         item_name(value) == f"Item #{int(value)}"})
    limit = max(1, min(int(max_types), 100))
    selected = unresolved[:limit]
    pending = max(0, len(unresolved) - limit)
    try:
        public_esi._load_cache()
    except Exception:
        pass
    failed = 0
    with ThreadPoolExecutor(max_workers=4) as pool:
        for type_id, name in pool.map(_fetch, selected):
            if not name:
                failed += 1
                continue
            try:
                type_repo.upsert(type_id, name)
            except Exception:
                failed += 1
    return {"requested": len(selected), "pending": pending, "failed": failed}


def refresh_current(wallet, asset):
    corp, div = int(wallet["corporation_id"]), int(wallet["division_id"])
    assets = (asset_selection.load_selected(
        int(asset["character_id"]), int(asset["item_id"]))["items"] if asset else [])
    orders = order_repo.load_orders(corp, div)
    transactions = repo.load_transactions("corporation", corp, div)
    physical = {int(row["type_id"]) for row in assets}
    contracts = repo.load_contract_assets("corporation", corp)
    relevant_contracts = [row for row in contracts
                          if int(row.get("type_id") or 0) in physical]
    return refresh(row["type_id"] for row in
                   assets + orders + transactions + relevant_contracts)
