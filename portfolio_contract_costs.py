#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Coûts contrat de valorisation, sans contamination du FIFO wallet."""


def attach_to_physical_assets(lots, asset_variants, contracts):
    """Ajoute un coût contrat seulement si le sous-arbre physique le justifie.

    Les contrats corporation n'ont pas de division wallet fiable. Ils ne sont
    donc jamais injectés avant les ventes FIFO et ne peuvent pas créer seuls
    une position hors du conteneur personnel sélectionné.
    """
    relevant = []
    grouped = {}
    for raw in contracts or ():
        row = dict(raw)
        if (not bool(row.get("is_included", True)) or
                not bool(row.get("is_acquisition", True))):
            continue
        tid = int(row.get("type_id") or 0)
        variant = (tid, int(row.get("raw_quantity") or 0) == -2)
        if tid <= 0 or int(asset_variants.get(variant, 0)) <= 0:
            continue
        relevant.append(row)
        grouped.setdefault(variant, []).append(row)
    for (tid, is_copy), rows in grouped.items():
        if lots.get(tid):
            continue
        remaining = int(asset_variants[tid, is_copy])
        for row in sorted(rows, key=lambda value: (str(value.get("acquired_at") or ""),
                                                   int(value.get("contract_id") or 0))):
            raw_cost = row.get("allocated_cost_cents")
            qty = int(row.get("quantity") or 0)
            if qty <= 0 or raw_cost is None or int(raw_cost) < 0 or remaining <= 0:
                continue
            cost = int(raw_cost)
            take = min(qty, remaining)
            part = (cost * take + qty // 2) // qty
            lots[tid].append({"quantity": take, "cost_cents": part,
                              "source": "contract"})
            remaining -= take
    return relevant
