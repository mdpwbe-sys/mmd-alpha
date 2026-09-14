#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Projection explicite ready/empty/stale/unavailable des sources locales."""
import repositories.portfolio_sync_repository as sync_repo


def _source(name, kind, owner_id, division, legacy_count=0, configured=True,
            legacy_available=None):
    if not configured:
        return {"state": "not_configured", "available": True, "empty": True,
                "row_count": 0, "last_success_at": None, "error": None}
    row = sync_repo.get_state(name, kind, owner_id, division)
    legacy = max(0, int(legacy_count or 0))
    evidence = bool(legacy) if legacy_available is None else bool(legacy_available)
    if not row:
        state = ("empty" if evidence and legacy == 0 else
                 "ready" if evidence else "never_synced")
        return {"state": state, "available": evidence,
                "empty": evidence and legacy == 0,
                "row_count": legacy, "last_success_at": None, "error": None}
    succeeded = row.get("last_success_at") is not None
    available = succeeded or evidence
    count = int(row.get("last_success_count") or 0) if succeeded else legacy
    stale = row.get("last_attempt_status") == "error"
    state = ("stale" if stale and available else "unavailable" if stale else
             "empty" if count == 0 else "ready")
    error = ({"kind": row.get("error_kind"), "status": row.get("error_status"),
              "message": row.get("error_message")} if stale else None)
    return {"state": state, "available": available, "empty": available and count == 0,
            "row_count": count, "last_success_at": row.get("last_success_at"),
            "error": error}


def build(wallet, asset, *, settings, asset_snapshot, transactions, orders, contracts):
    corp, div = int(wallet["corporation_id"]), int(wallet["division_id"])
    cash_known = wallet["key"] in (settings.get("cash_balances") or {})
    sources = {
        "cash": _source("cash", "corporation", corp, div, int(cash_known),
                        legacy_available=cash_known),
        "transactions": _source("transactions", "corporation", corp, div,
                                len(transactions)),
        "orders": _source("orders", "corporation", corp, div, len(orders)),
        "contracts": _source("contracts", "corporation", corp, 0, len(contracts)),
    }
    if asset:
        sources["assets"] = _source("assets", "character", int(asset["character_id"]), 0,
                                    int((asset_snapshot or {}).get("items_count") or 0),
                                    legacy_available=asset_snapshot is not None)
    else:
        sources["assets"] = _source("assets", "character", 1, 0, configured=False)
    return sources


def apply(data, sources, errors=()):
    summary = data["summary"]
    if not sources["cash"]["available"]:
        summary["cash_cents"] = None
    if not sources["orders"]["available"]:
        summary["buy_escrow_cents"] = None
    if not sources["transactions"]["available"]:
        for key in ("realized_pnl_cents", "monthly_return_bp", "days_running"):
            summary[key] = None
    holdings = sources["orders"]["available"] and sources["assets"]["available"]
    if not holdings:
        summary["inventory_value_cents"] = summary["unrealized_pnl_cents"] = None
    # Unrealized P&L is additive.  An asset with unknown basis/valuation must
    # not erase another position whose FIFO basis and valuation are usable.
    valued_assets = [row for row in data.get("assets", ())
                     if row.get("cost_known") and int(row.get("valuation_price_cents") or 0) > 0]
    if data.get("assets"):
        summary["unrealized_pnl_cents"] = (
            str(sum(int(row.get("unrealized_pnl_cents") or 0) for row in valued_assets))
            if valued_assets else None)
    values = (summary.get("cash_cents"), summary.get("inventory_value_cents"),
              summary.get("buy_escrow_cents"))
    summary["fund_value_cents"] = (str(sum(int(value) for value in values))
                                   if all(value is not None for value in values) else None)
    missing = [f"{name}: {row['state']}" for name, row in sources.items()
               if not row["available"]]
    source_errors = [row["error"] for row in sources.values() if row.get("error")]
    data.update(availability=sources, complete=not missing and not errors and not source_errors,
                stale=bool(missing or errors or source_errors),
                sync_errors=list(errors) + source_errors + missing)
    return data
