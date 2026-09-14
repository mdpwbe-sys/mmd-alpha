#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Indicateurs de performance exacts calculés depuis les ventes FIFO."""
from datetime import date, datetime, timedelta, timezone


def market_metrics(rows):
    usable = [row for row in rows if int(row.get("avg_cents") or 0) > 0][-30:]
    if not usable:
        return {"median_cents": None, "p75_cents": None,
                "daily_volume": None, "history_available": False}
    prices = sorted(int(row["avg_cents"]) for row in usable)
    middle = len(prices) // 2
    median = prices[middle] if len(prices) % 2 else (prices[middle - 1] + prices[middle]) // 2
    return {"median_cents": median,
            "p75_cents": prices[((len(prices) - 1) * 75 + 50) // 100],
            "daily_volume": sum(int(row.get("volume") or 0) for row in usable) // len(usable),
            "history_available": True}


def days_running(transactions):
    values = [str(row.get("date") or "")[:10] for row in transactions if row.get("date")]
    if not values:
        return 0
    try:
        start = datetime.strptime(min(values), "%Y-%m-%d").replace(tzinfo=timezone.utc)
        return max(1, (datetime.now(timezone.utc) - start).days + 1)
    except ValueError:
        return 0


def transaction_order(row):
    value = row.get("transaction_id")
    try:
        return str(row.get("date") or ""), 0, int(value)
    except (TypeError, ValueError):
        return str(row.get("date") or ""), 1, str(value or "")


def alert(rank, action, type_id, name, message, value):
    return {"_rank": rank, "severity": ("critical", "warning", "info")[rank],
            "action": action, "type_id": str(type_id), "name": name,
            "message": message,
            "value_cents": str(int(value)) if value is not None else None}


def trailing_realized_return_bp(rows, days=30, as_of=None):
    """Rendement réalisé glissant, rapporté au coût FIFO des ventes couvertes."""
    observations = []
    for row in rows or ():
        if row.get("side") != "SELL" or not row.get("cost_known"):
            continue
        try:
            day = datetime.strptime(str(row.get("date") or "")[:10], "%Y-%m-%d").date()
            cost = int(row.get("realized_cost_cents") or 0)
            profit = int(row.get("realized_profit_cents") or 0)
        except (TypeError, ValueError):
            continue
        if cost > 0:
            observations.append((day, cost, profit))
    if not observations:
        return None
    today = as_of if isinstance(as_of, date) else date.today()
    cutoff = today - timedelta(days=max(1, int(days)) - 1)
    recent = [row for row in observations if row[0] >= cutoff]
    cost = sum(row[1] for row in recent)
    return sum(row[2] for row in recent) * 10_000 // cost if cost else None
