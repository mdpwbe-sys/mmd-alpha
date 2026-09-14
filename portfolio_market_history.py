#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Historique ESI par région réellement détenue/listée, avec fallback explicite."""
from concurrent.futures import ThreadPoolExecutor
from collections import defaultdict
from datetime import date, timedelta
import time

import mmd_esi as public_esi
import portfolio_locations as stations
import portfolio_asset_selection as asset_selection
import repositories.corporation_order_repository as order_repo
import repositories.market_history_repository as history_repo
import repositories.portfolio_repository as repo

THE_FORGE = 10000002
HISTORY_ATTEMPT_TTL = 3600


def pending_history_pairs(regions, attempts, now, has_recent):
    """Fair queue: empty/error responses cannot monopolise the first batch."""
    pairs = [(region, tid) for tid, region in regions.items()
             if not has_recent(region, tid) and
             now - attempts.get(f'{region}:{tid}', 0) >= HISTORY_ATTEMPT_TTL]
    return sorted(pairs, key=lambda pair: (attempts.get(f'{pair[0]}:{pair[1]}', 0), pair))


def asset_station(asset):
    if not asset:
        return None
    if asset.get("kind") == "station":
        return int(asset["location_id"])
    full = repo.load_latest_assets(int(asset["character_id"]), None)["items"]
    by_id = {int(row["item_id"]): row for row in full}
    target = by_id.get(int(asset["item_id"]))
    root = by_id.get(int((target or {}).get("root_container_id") or
                         (target or {}).get("item_id") or 0), target)
    return int((root or {}).get("location_id") or 0) or None


def _asset_region(asset):
    location = asset_station(asset)
    return stations.station_details(location).get("region_id") if location else None


def type_regions(wallet, asset, assets, orders, transactions):
    asset_region = _asset_region(asset)
    regions = {}
    for row in assets:
        if not row.get("is_container") and asset_region:
            regions[int(row["type_id"])] = int(asset_region)
    order_weights = defaultdict(lambda: defaultdict(int))
    for row in orders:
        region = row.get("region_id")
        if region:
            tid = int(row["type_id"])
            order_weights[tid][int(region)] += max(
                1, int(row.get("price_cents") or 0) *
                int(row.get("volume_remain") or 0))
    for tid, choices in order_weights.items():
        if tid not in regions:
            regions[tid] = min(choices, key=lambda region: (-choices[region], region))
    transaction_weights = defaultdict(lambda: defaultdict(int))
    for row in transactions:
        tid = int(row["type_id"])
        if tid not in regions:
            region = stations.station_details(row.get("location_id")).get("region_id")
            if region:
                transaction_weights[tid][int(region)] += max(
                    1, int(row.get("unit_price_cents") or 0) *
                    int(row.get("quantity") or 0))
    for tid, choices in transaction_weights.items():
        regions[tid] = min(choices, key=lambda region: (-choices[region], region))
    return regions


def load_context(wallet, asset, assets, orders, transactions, contracts):
    physical = {int(row["type_id"]) for row in assets
                if not row.get("is_container")}
    active = physical | {int(row["type_id"]) for row in orders + transactions}
    # Les contrats corporation sont globaux : seuls ceux qui peuvent valoriser
    # un type réellement présent dans le conteneur ont besoin d'un historique.
    contract_types = {int(row["type_id"]) for row in contracts
                      if int(row.get("type_id") or 0) in physical}
    type_ids = active | contract_types
    regions = type_regions(wallet, asset, assets, orders, transactions)
    grouped, market = {}, {}
    for tid in type_ids:
        region = regions.get(tid)
        rows = repo.load_history([tid], region_id=region) if region else []
        fallback = False
        if not rows and region != THE_FORGE:
            rows = repo.load_history([tid], region_id=THE_FORGE)
            fallback = bool(rows)
        grouped[tid] = rows
        market[tid] = {"valuation_region_id": (THE_FORGE if fallback else region),
                       "regional_history": bool(rows),
                       "forge_fallback": fallback}
    return grouped, market, regions


def refresh_current(wallet, asset, max_pairs=40):
    corp, div = int(wallet["corporation_id"]), int(wallet["division_id"])
    bundle = (asset_selection.load_selected(int(asset["character_id"]), int(asset["item_id"]), asset.get('kind', 'container'))
              if asset else {"items": []})
    assets, orders = bundle["items"], order_repo.load_orders(corp, div)
    transactions = repo.load_transactions("corporation", corp, div)
    regions = type_regions(wallet, asset, assets, orders, transactions)
    cutoff = (date.today() - timedelta(days=3)).isoformat()
    now = time.time()
    attempts = repo.get_settings().get('history_attempts', {})
    missing = pending_history_pairs(regions, attempts, now,
        lambda region, tid: bool(repo.load_history([tid], region_id=region, since=cutoff)))
    limit = max(1, int(max_pairs))
    selected, pending = missing[:limit], max(0, len(missing) - limit)
    public_esi._load_cache()

    def fetch(pair):
        region, tid = pair
        url = (f"{public_esi.ESI}/markets/{region}/history/"
               f"?datasource=tranquility&type_id={tid}")
        try:
            data, state = public_esi._get(url, include_cache_state=True)
            return pair, data, state
        except Exception:
            return pair, None, "unavailable"

    failed = stale = 0
    with ThreadPoolExecutor(max_workers=4) as pool:
        for (region, tid), rows, state in pool.map(fetch, selected):
            attempts[f'{region}:{tid}'] = now
            if state == "stale_cache":
                stale += 1
            elif rows is None:
                failed += 1
            else:
                history_repo.upsert(region, tid, rows)
    # Bounded retention; ESI's own cache/rate limiter still owns HTTP requests.
    repo.save_setting('history_attempts', {key: stamp for key, stamp in attempts.items()
                                         if now - stamp < 7 * 86400})
    return {"requested": len(selected), "pending": pending,
            "failed": failed, "stale": stale}
