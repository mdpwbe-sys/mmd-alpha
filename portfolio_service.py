#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Orchestration read-only ESI -> SQLite -> moteur Asset/Transaction."""
import json
import threading
import time
import mmd_esi_portfolio as esi
import mmd_sso as sso
import migrations
import portfolio_availability as availability
import portfolio_engine as engine
import portfolio_asset_selection as asset_selection
import portfolio_locations as locations
import portfolio_fees as fees
import portfolio_market_history as market_history
import portfolio_refresh
import portfolio_saved_sources as saved_sources
import portfolio_types as types
import repositories.character_repository as characters
import repositories.corporation_order_repository as corporation_orders
import repositories.portfolio_repository as repo
_LOCK = threading.RLock()
_DISCOVERY = {"at": 0.0, "data": None, "last_good": None,
              "last_good_fingerprint": None}
_DISCOVERY_TTL = 300
def _discover(force=False):
    fingerprint = tuple((row["id"], tuple(sorted(sso.character_capabilities(row["id"]).items())))
                        for row in sso.connected_chars())
    with _LOCK:
        if not force and _DISCOVERY["data"] and _DISCOVERY.get("fingerprint") == fingerprint and time.time() - _DISCOVERY["at"] < _DISCOVERY_TTL:
            return _DISCOVERY["data"]
        try:
            data = esi.discover_sources()
        except Exception as exc:
            if (_DISCOVERY.get("last_good") and
                    _DISCOVERY.get("last_good_fingerprint") == fingerprint):
                data = dict(_DISCOVERY["last_good"], errors=[{"error": {
                    "kind": type(exc).__name__,
                    "message": f"Découverte ESI impossible : {exc}"}}])
            else:
                raise
        if not data.get("errors"):
            _DISCOVERY.update(last_good=data, last_good_fingerprint=fingerprint)
        elif (_DISCOVERY.get("last_good") and
              _DISCOVERY.get("last_good_fingerprint") == fingerprint):
            data = dict(_DISCOVERY["last_good"], errors=data["errors"])
        stamp = time.time() if not data.get("errors") else time.time() - (_DISCOVERY_TTL - 30)
        _DISCOVERY.update(at=stamp, data=data, fingerprint=fingerprint)
        for char in data.get("characters", []):
            if char.get("corporation_id"):
                characters.upsert_character(char["id"], char.get("name"),
                                            char["corporation_id"], 1)
        return data


def _options(discovered):
    chars = {str(row["id"]): row for row in discovered.get("characters", [])}
    operators = {}
    for row in chars.values():
        corp = row.get("corporation_id")
        if corp and row.get("capabilities", {}).get("corporation_wallet"):
            operators.setdefault(str(corp), row)
    divisions = []
    for corp_id, rows in discovered.get("divisions", {}).items():
        operator = operators.get(str(corp_id))
        if not operator:
            continue
        for row in rows:
            div = int(row["division_id"])
            name = row.get("name") or row.get("label") or f"Division {div}"
            divisions.append({"key": f"corp:{corp_id}:division:{div}",
                              "corporation_id": str(corp_id), "division_id": str(div),
                              "character_id": str(operator["id"]), "name": name,
                              "label": f"{name} · #{div}"})
    containers = []
    for char_id, rows in discovered.get("containers", {}).items():
        char_name = chars.get(str(char_id), {}).get("name") or f"Personnage {char_id}"
        for row in rows:
            item_id = str(row["item_id"])
            name = row.get("name") or row.get("label") or f"Conteneur {item_id}"
            containers.append({"key": f"char:{char_id}:container:{item_id}", "kind": "container",
                               "character_id": str(char_id), "item_id": item_id,
                               "location_id": str(row.get("location_id") or ""),
                               "root_location_id": str(row.get("root_location_id") or ""),
                               "parent_item_id": None, "name": f"{char_name} · {name}",
                               "path": [char_name, name], "depth": int(row.get("depth") or 0),
                               "descendant_count": int(row.get("descendant_count") or 0)})
    # Offline station metadata only; selection does not add ESI requests.
    station_roots = {}
    for char_id, rows in discovered.get("containers", {}).items():
        for row in rows:
            root = row.get("root_location_id")
            if root and row.get("root_location_type") in ("station", "other"):
                station_roots[(str(char_id), str(root))] = row.get("root_location_type")
    for char_id, rows in discovered.get("assets_by_character", {}).items():
        for row in rows:
            if row.get("location_type") in ("station", "other"):
                station_roots[(str(char_id), str(row["location_id"]))] = row["location_type"]
    station_options = []
    for (char_id, location_id), location_type in sorted(station_roots.items()):
        details = locations.station_details(location_id)
        if location_type != 'station' and not details.get('solar_system_id') and int(location_id) < 1000000000000:
            continue  # Do not turn solar-system or unresolved item roots into stations.
        station_name = details.get('name') or f'Station / structure {location_id}'
        char_name = chars.get(char_id, {}).get('name') or f'Personnage {char_id}'
        station_options.append(dict(key=f'char:{char_id}:station:{location_id}', kind='station',
            character_id=char_id, item_id=location_id, location_id=location_id,
            root_location_id=location_id, station_name=station_name,
            name=f'{char_name} · {station_name}', path=[char_name, station_name], depth=0))
        for container in containers:
            if container['character_id'] == char_id and container['root_location_id'] == location_id:
                container['station_name'] = station_name
                container['depth'] += 1
                container['path'].insert(1, station_name)
    containers.extend(station_options)
    containers.sort(key=lambda row: (row['character_id'], row.get('station_name', 'Lieu inconnu').casefold(),
                                    row.get('root_location_id', ''), row['kind'] != 'station',
                                    row['depth'], row['name'].casefold(), row['key']))
    return divisions, containers


def _match(options, source):
    key = str((source or {}).get("key") or "")
    return next((dict(row) for row in options if str(row["key"]) == key), None)


def get_settings(force=False):
    migrations.migrate()
    try:
        discovered = _discover(force)
        divisions, containers = _options(discovered)
        saved = repo.get_settings()
        wallet = _match(divisions, saved.get("wallet_source"))
        assets = _match(containers, saved.get("asset_source"))
        return {"ok": True, "wallet_source": wallet, "asset_source": assets,
                "divisions": divisions, "containers": containers,
                "characters": discovered.get("characters", []),
                "errors": discovered.get("errors", [])}
    except Exception as exc:
        return {"ok": False, "error": f"Découverte ESI impossible : {exc}",
                "divisions": [], "containers": []}


def save_settings(payload):
    migrations.migrate()
    try:
        value = json.loads(payload) if isinstance(payload, str) else dict(payload or {})
        current = get_settings(False)
        if not current.get("ok"):
            return current
        wallet = _match(current["divisions"], value.get("wallet_source"))
        asset = _match(current["containers"], value.get("asset_source"))
        if not wallet:
            return {"ok": False, "error": "Division corporation invalide ou disparue."}
        if value.get("asset_source") and not asset:
            return {"ok": False, "error": "Conteneur personnel invalide ou disparu."}
        repo.save_setting("wallet_source", {k: wallet[k] for k in
                          ("key", "corporation_id", "division_id", "character_id", "name", "label")})
        repo.save_setting("asset_source", ({k: asset[k] for k in
                          ("key", "character_id", "item_id", "name", "path",
                           "location_id", "root_location_id", "kind")} if asset else None))
        return {"ok": True, "wallet_source": wallet, "asset_source": asset}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _selection(filters=None, live=True):
    if not live:
        containers = _options(_DISCOVERY["data"])[1] if _DISCOVERY.get("data") else ()
        wallet, asset, error = saved_sources.load(
            (filters or {}).get("container_key"), containers)
        return {}, (None if error else (wallet, asset) if wallet else None), error
    settings = get_settings(live)
    if not settings.get("ok"):
        return settings, None, settings
    wallet = settings.get("wallet_source")
    if not wallet and settings.get("errors"):
        wallet, asset, saved_error = saved_sources.load(
            (filters or {}).get("container_key"), settings.get("containers", ()))
        if wallet and not saved_error:
            return settings, (wallet, asset), None
    if not wallet:
        return settings, None, {"ok": False, "error": "Choisissez une division corporation dans Settings."}
    requested = str((filters or {}).get("container_key") or "")
    asset = (next((row for row in settings["containers"] if row["key"] == requested), None)
             if requested else settings.get("asset_source"))
    return settings, (wallet, asset), None


def _workspace(wallet, asset, errors=()):
    corp, div = int(wallet["corporation_id"]), int(wallet["division_id"])
    bundle = (asset_selection.load_selected(int(asset["character_id"]), int(asset["item_id"]),
                                           source_kind=asset.get("kind", "container"))
              if asset else {"snapshot": None, "items": []})
    assets = bundle["items"]
    parent_ids = {int(row["parent_item_id"]) for row in assets if row.get("parent_item_id")}
    for row in assets:
        row["is_container"] = int(row["item_id"]) in parent_ids or int(row["item_id"]) == int(asset["item_id"])
        row["name"] = types.item_name(row["type_id"])
    transactions = repo.load_transactions("corporation", corp, div)
    source = f"Corporation {corp} · {wallet['name']} (#{div})"
    for row in transactions:
        row.update(date=row.get("occurred_at"), name=types.item_name(row["type_id"]), source_label=source)
        if row.get("fees_status") == "actual":
            row["actual_fee_cents"] = int(row.get("broker_fee_cents") or 0) + int(row.get("sales_tax_cents") or 0)
    transactions = fees.enrich(transactions)
    # Une ancienne ligne ``missing`` devient ainsi auditable après résolution
    # générique de sa station. Un éventuel montant ``actual`` reste prioritaire
    # via la règle d'upsert du repository.
    repo.upsert_transactions(transactions)
    orders = fees.enrich(corporation_orders.load_orders(corp, div))
    for row in orders:
        row["name"] = types.item_name(row["type_id"])
    contracts = repo.load_contract_assets("corporation", corp)
    for row in contracts:
        row.update(name=types.item_name(row["type_id"]), acquired_at=row.get("completed_at") or row.get("issued_at") or "")
    grouped, market, _regions = market_history.load_context(
        wallet, asset, assets, orders, transactions, contracts)
    asset_rates = fees.rates_for_station(market_history.asset_station(asset))
    for row in assets:
        market.setdefault(int(row["type_id"]), {}).setdefault(
            "sell_fee_rate_ppm", asset_rates["broker_rate_ppm"] +
            asset_rates["sales_tax_rate_ppm"])
    settings = repo.get_settings()
    cash = (settings.get("cash_balances") or {}).get(wallet["key"], 0)
    data = engine.build_workspace(transactions=transactions, assets=assets, orders=orders,
                                  contracts=contracts, history=grouped, market=market,
                                  cash_cents=int(cash),
                                  source_label=source)
    repo.save_fifo_results("corporation", corp, div, data["transactions"], "portfolio_fifo_v1")
    data.update(wallet_source={k: wallet[k] for k in ("key", "corporation_id", "division_id")},
                asset_source=asset)
    sources = availability.build(wallet, asset, settings=settings,
                                 asset_snapshot=bundle["snapshot"], transactions=transactions,
                                 orders=orders, contracts=contracts)
    return availability.apply(data, sources, errors)


def get_workspace(filters=None, refresh=False):
    migrations.migrate()
    settings, selected, error = _selection(filters, refresh)
    if error:
        return error
    wallet, asset = selected
    errors = portfolio_refresh.run(wallet, asset, settings.get("characters", ())) if refresh else []
    data = _workspace(wallet, asset, errors)
    data["cached"] = not refresh
    return data
