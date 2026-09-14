#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Refresh portefeuille tolérant aux erreurs, source par source."""
from collections import Counter

import mmd_asset_tree as asset_tree
import mmd_corporation_orders as corporation_orders_esi
import mmd_core as core
import mmd_esi_portfolio as esi
import mmd_sso as sso
import portfolio_fees as fees
import portfolio_market_history as market_history
import portfolio_locations as locations
import portfolio_types as types
import repositories.corporation_order_repository as corporation_orders
import repositories.portfolio_repository as repo
import repositories.portfolio_sync_repository as states


def _error(source, error):
    return {"source": source, "kind": getattr(error, "kind", type(error).__name__),
            "status": getattr(error, "status", None),
            "message": getattr(error, "message", str(error))}


def _failed(errors, source, scope, error):
    detail = _error(source, error)
    try:
        states.mark_failure(source, *scope, detail)
    except Exception:
        pass
    errors.append(detail)


def _orders_failed(errors, corporation_id, error):
    detail = _error("orders", error)
    for division in range(1, 8):
        try:
            states.mark_failure("orders", "corporation", corporation_id,
                                division, detail)
        except Exception:
            pass
    errors.append(detail)


def _candidates(corp, capability, characters, preferred=None):
    ids = []
    if preferred and sso.character_capabilities(preferred).get(capability):
        ids.append(int(preferred))
    for row in characters or ():
        if int(row.get("corporation_id") or 0) == corp and row.get(
                "capabilities", {}).get(capability):
            cid = int(row["id"])
            if cid not in ids:
                ids.append(cid)
    return ids


def _attempt(ids, call):
    last = None
    for character_id in ids:
        try:
            result = call(character_id)
        except Exception as exc:
            last = exc
            continue
        if getattr(result, "ok", False):
            return result
        last = getattr(result, "error", None) or RuntimeError(
            "Réponse ESI invalide")
    return None, last or RuntimeError("Aucun token habilité")


def _sync_transactions(wallet, characters, errors):
    corp, div = int(wallet["corporation_id"]), int(wallet["division_id"])
    scope = ("corporation", corp, div)
    ids = _candidates(corp, "corporation_wallet", characters, wallet.get("character_id"))
    attempted = _attempt(ids, lambda cid: esi.fetch_corporation_transactions(
        corp, div, cid, known_ids={row["transaction_id"] for row in
                                   repo.load_transactions(*scope)}))
    if isinstance(attempted, tuple):
        return _failed(errors, "transactions", scope, attempted[1])
    try:
        rows = fees.enrich([dict(row, owner_kind="corporation", owner_id=corp,
                            division_id=div, occurred_at=row.get("date"),
                            is_personal=False) for row in attempted.data])
        repo.upsert_transactions(rows)
        states.mark_success("transactions", *scope, len(repo.load_transactions(*scope)))
    except Exception as exc:
        _failed(errors, "transactions", scope, exc)


def _sync_cash(wallet, characters, errors):
    corp, div = int(wallet["corporation_id"]), int(wallet["division_id"])
    scope = ("corporation", corp, div)
    ids = _candidates(corp, "corporation_wallet", characters, wallet.get("character_id"))
    attempted = _attempt(ids, lambda cid: esi.fetch_corporation_balance(corp, cid, div))
    if isinstance(attempted, tuple):
        return _failed(errors, "cash", scope, attempted[1])
    try:
        balances = dict(repo.get_settings().get("cash_balances") or {})
        balances[wallet["key"]] = str(attempted.data["balance_cents"])
        repo.save_setting("cash_balances", balances)
        states.mark_success("cash", *scope, 1)
    except Exception as exc:
        _failed(errors, "cash", scope, exc)


def _sync_orders(wallet, characters, errors):
    corp, div = int(wallet["corporation_id"]), int(wallet["division_id"])
    ids = _candidates(corp, "corporation_orders", characters, wallet.get("character_id"))
    attempted = _attempt(ids, lambda cid: corporation_orders_esi.fetch_corporation_orders(corp, cid))
    if isinstance(attempted, tuple):
        return _orders_failed(errors, corp, attempted[1])
    try:
        corporation_orders.replace_orders(corp, attempted.data)
        counts = Counter(int(row["division_id"]) for row in attempted.data)
        for division in range(1, 8):
            states.mark_success("orders", "corporation", corp, division,
                                counts[division])
    except Exception as exc:
        _orders_failed(errors, corp, exc)


def _sync_assets(asset, errors):
    if not asset:
        return
    cid, scope = int(asset["character_id"]), ("character", int(asset["character_id"]), 0)
    fetched = esi.fetch_character_assets(cid)
    if not fetched.ok:
        return _failed(errors, "assets", scope, fetched.error)
    try:
        parent_ids = {int(row["location_id"]) for row in fetched.data
                      if row.get("location_type") == "item"}
        named = esi.fetch_asset_names(cid, parent_ids)
        graph = asset_tree.build_asset_tree(fetched.data, named.data if named.ok else None)
        items = []
        for raw in fetched.data:
            item, iid = dict(raw), int(raw["item_id"])
            item.update(parent_item_id=graph.parent.get(iid), root_container_id=graph.root_id(iid),
                        hierarchy_depth=graph.depth(iid), item_name=core.iname(item["type_id"]),
                        is_blueprint_copy=bool(item.get("is_blueprint_copy", False)))
            items.append(item)
        repo.save_asset_snapshot(cid, None, items)
        states.mark_success("assets", *scope, len(items))
        if not named.ok:
            errors.append(_error("asset_names", named.error))
    except Exception as exc:
        _failed(errors, "assets", scope, exc)


def _sync_contracts(wallet, characters, errors):
    corp, scope = int(wallet["corporation_id"]), ("corporation", int(wallet["corporation_id"]), 0)
    ids = _candidates(corp, "corporation_contracts", characters, wallet.get("character_id"))
    known = {row["contract_id"] for row in repo.load_contract_assets("corporation", corp)}
    attempted = _attempt(ids, lambda cid: esi.fetch_corporation_contract_assets(
        corp, cid, known_contract_ids=known))
    if isinstance(attempted, tuple):
        return _failed(errors, "contracts", scope, attempted[1])
    try:
        rows = [dict(raw, owner_kind="corporation", owner_id=corp, division_id=0,
                     is_acquisition=True, allocated_cost_cents=raw.get("acquisition_cost_cents"),
                     contract_price_cents=raw.get("contract_total_cents", 0),
                     allocation_method="single_item" if raw.get("acquisition_cost_cents") is not None else "unallocated")
                for raw in attempted.data]
        repo.upsert_contract_assets(rows)
        pending = int(attempted.headers.get("X-Contracts-Pending", 0))
        failed = int(attempted.headers.get("X-Contracts-Failed", 0))
        if pending or failed:
            raise RuntimeError(f"Contrats partiels: {pending} en attente, {failed} en erreur")
        total = len(repo.load_contract_assets("corporation", corp))
        states.mark_success("contracts", *scope, total)
    except Exception as exc:
        _failed(errors, "contracts", scope, exc)


def run(wallet, asset, characters=()):
    errors = []
    corp, div = int(wallet["corporation_id"]), int(wallet["division_id"])
    jobs = [
        ("transactions", ("corporation", corp, div),
         lambda: _sync_transactions(wallet, characters, errors)),
        ("orders", ("corporation", corp, div),
         lambda: _sync_orders(wallet, characters, errors)),
        ("cash", ("corporation", corp, div),
         lambda: _sync_cash(wallet, characters, errors)),
        ("contracts", ("corporation", corp, 0),
         lambda: _sync_contracts(wallet, characters, errors)),
    ]
    if asset:
        jobs.insert(3, ("assets", ("character", int(asset["character_id"]), 0),
                        lambda: _sync_assets(asset, errors)))
    for source, scope, job in jobs:
        try:
            job()
        except Exception as exc:
            _failed(errors, source, scope, exc)
    try:
        result = types.refresh_current(wallet, asset)
        if result["pending"] or result["failed"]:
            errors.append({"source": "type_names", "kind": "partial",
                           "status": None, "message":
                           f"Noms ESI: {result['pending']} en attente, "
                           f"{result['failed']} en erreur"})
    except Exception as exc:
        errors.append(_error("type_names", exc))
    try:
        result = locations.refresh_current(wallet, asset, characters)
        if result["pending"] or result["failed"]:
            errors.append({"source": "locations", "kind": "partial",
                           "status": None, "message":
                           f"Lieux ESI: {result['pending']} en attente, "
                           f"{result['failed']} en erreur"})
    except Exception as exc:
        errors.append(_error("locations", exc))
    try:
        result = market_history.refresh_current(wallet, asset)
        stale = result.get("stale", 0)
        if result["pending"] or result["failed"] or stale:
            errors.append({"source": "market_history", "kind": "partial",
                           "status": None, "message":
                           f"Historique régional: {result['pending']} en attente, "
                           f"{result['failed']} en erreur, {stale} cache expiré"})
    except Exception as exc:
        errors.append(_error("market_history", exc))
    return errors
