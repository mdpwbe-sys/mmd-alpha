#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Taux de transaction par station et profil, sans modifier mmd_margin."""
from decimal import Decimal, ROUND_HALF_UP

import mmd_margin as margin
import portfolio_locations as stations

RATE_SCALE = Decimal("1000000")


def _ppm(rate):
    return int((Decimal(rate) * RATE_SCALE).to_integral_value(rounding=ROUND_HALF_UP))


def rates_for_station(station_id, cfg=None):
    """Retourne courtage/taxe en millioniemes; zéro explicite si lieu inconnu."""
    try:
        sid = int(station_id or 0)
    except (TypeError, ValueError):
        sid = 0
    if not sid:
        return {"broker_rate_ppm": 0, "sales_tax_rate_ppm": 0,
                "fee_source": "location-unavailable"}
    cfg = cfg or margin.load_config()
    kind, faction, corporation = margin.station_kind(sid)
    details = stations.station_details(sid)
    mapped = margin.NPC_STATIONS.get(sid)
    trusted_mapping = bool(mapped and mapped[1].casefold() in
                           str(details.get("name") or "").casefold())
    if kind == "upwell":
        broker = margin.upwell_broker_rate(cfg.get("upwell_owner_fee", 0))
        source = "station-upwell-profile"
        faction = corporation = None
    elif trusted_mapping:
        broker = margin.rate_for_station(sid, cfg)
        source = "station-npc-standings"
    else:
        # Owner inconnu: profil BR applique, standings neutres (conservateur).
        broker = margin.npc_broker_rate(cfg.get("broker_relations", 0),
                                        Decimal("0"), Decimal("0"))
        source = "station-npc-owner-unresolved"
        faction = corporation = None
    tax = margin.sales_tax_rate(cfg.get("accounting", 0))
    owner = ("/".join(v for v in (faction, corporation) if v) or
             (f"NPC corporation #{details['npc_owner_id']}"
              if details.get("npc_owner_id") else "NPC owner unresolved"))
    return {"broker_rate_ppm": _ppm(broker),
            "sales_tax_rate_ppm": _ppm(tax),
            "station_kind": kind, "fee_source": source,
            "station_owner": owner, "station_name": details.get("name"),
            "region_id": details.get("region_id")}


def _fee(amount, rate_ppm):
    return (int(amount) * int(rate_ppm or 0) + 500_000) // 1_000_000


def enrich(rows, cfg=None):
    """Copie les lignes et ajoute leurs taux calculés depuis location_id."""
    cfg = cfg or margin.load_config()
    out = []
    for row in rows or ():
        enriched = dict(row)
        enriched.update(rates_for_station(row.get("location_id"), cfg))
        if enriched.get("fees_status") != "actual":
            gross = int(enriched.get("unit_price_cents") or
                        enriched.get("price_cents") or 0) * int(
                            enriched.get("quantity") or enriched.get("volume_remain") or 0)
            broker = _fee(gross, enriched["broker_rate_ppm"])
            if enriched["broker_rate_ppm"]:
                broker = max(10_000, broker)
            tax = (0 if bool(enriched.get("is_buy", enriched.get("is_buy_order")))
                   else _fee(gross, enriched["sales_tax_rate_ppm"]))
            enriched.update(broker_fee_cents=broker, sales_tax_cents=tax,
                            fees_status=("estimated" if enriched["broker_rate_ppm"]
                                         else "missing"))
        out.append(enriched)
    return out
