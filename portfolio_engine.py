#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Calculs portfolio exacts en centiemes d'ISK (aucun float)."""
from collections import defaultdict, deque
import portfolio_metrics as metrics
import portfolio_contract_costs as contract_costs
from portfolio_valuation import bpc_value_cents

RISE_BP = 1000
ILLIQUID_DAILY_VOLUME = 10
RATE_SCALE = 1_000_000


def _money(value):
    return str(int(value or 0))


def _fee(amount, rate_ppm):
    return (int(amount) * int(rate_ppm or 0) + RATE_SCALE // 2) // RATE_SCALE


def _trade_fees(row, gross, is_buy):
    actual = row.get("actual_fee_cents")
    if actual is not None:
        return int(actual), "actual"
    broker_rate = int(row.get("broker_rate_ppm") or 0)
    tax_rate = 0 if is_buy else int(row.get("sales_tax_rate_ppm") or 0)
    broker = _fee(gross, broker_rate)
    if broker_rate:
        broker = max(10_000, broker)  # charge courtage minimale CCP: 100 ISK
    return broker + _fee(gross, tax_rate), ("estimated" if broker_rate else "unavailable")


def _consume(lots, quantity):
    wanted, cost, known = int(quantity), 0, 0
    while wanted > 0 and lots:
        lot = lots[0]
        take = min(wanted, lot["quantity"])
        part = (lot["cost_cents"] * take + lot["quantity"] // 2) // lot["quantity"]
        cost += part
        known += take
        lot["cost_cents"] -= part
        lot["quantity"] -= take
        wanted -= take
        if not lot["quantity"]:
            lots.popleft()
    return cost, known, wanted == 0


def _fifo(transactions):
    lots, realized, rendered = defaultdict(deque), 0, []
    ordered = sorted(transactions, key=metrics.transaction_order)
    for row in ordered:
        tid = int(row.get("type_id") or 0)
        qty = max(0, int(row.get("quantity") or 0))
        if not tid or not qty:
            continue
        unit = int(row.get("unit_price_cents") or 0)
        gross = unit * qty
        is_buy = bool(row.get("is_buy"))
        if is_buy:
            fees, fee_status = _trade_fees(row, gross, True)
            lots[tid].append({"quantity": qty, "cost_cents": gross + fees,
                              "source": "market"})
            fifo_cost, profit, known = gross + fees, 0, True
        else:
            fees, fee_status = _trade_fees(row, gross, False)
            fifo_cost, consumed_qty, known = _consume(lots[tid], qty)
            profit = gross - fees - fifo_cost if known else 0
            if known:
                realized += profit
        rendered.append({
            "transaction_id": str(row.get("transaction_id") or ""),
            "date": row.get("date") or "", "type_id": str(tid),
            "name": row.get("name") or f"Item #{tid}",
            "side": "BUY" if is_buy else "SELL", "quantity": qty,
            "unit_price_cents": _money(unit), "total_cents": _money(gross),
            "fees_cents": _money(fees),
            "fifo_cost_cents": _money(fifo_cost) if is_buy or consumed_qty else None,
            "realized_pnl_cents": _money(profit) if not is_buy and known else None,
            "cost_known": bool(known),
            "fee_known": fee_status != "unavailable", "fee_status": fee_status,
            "fee_source": "journal" if fee_status == "actual" else row.get("fee_source", ""),
            "broker_rate_ppm": int(row.get("broker_rate_ppm") or 0),
            "sales_tax_rate_ppm": int(row.get("sales_tax_rate_ppm") or 0),
            "consumed_quantity": qty if is_buy else consumed_qty,
            "matched_quantity": 0 if is_buy else consumed_qty,
            "realized_cost_cents": None if is_buy else fifo_cost,
            "realized_profit_cents": profit if not is_buy and known else None,
            "fifo_status": "complete" if is_buy or known else ("partial" if consumed_qty else "unknown_basis"),
            "source": row.get("source_label") or row.get("source_kind") or "",
            "location_id": str(row.get("location_id") or ""),
            "owner_name": row.get("owner_name") or row.get("source_label") or "",
            "station_name": row.get("station_name") or (f"Location #{row.get('location_id')}" if row.get("location_id") else ""),
        })
    return lots, realized, list(reversed(rendered))


def build_workspace(*, transactions=(), assets=(), orders=(), contracts=(),
                    history=None, market=None, cash_cents=0, source_label=""):
    """Construit Dashboard, Assets, Transactions et Alerts depuis une source FIFO."""
    history, market = history or {}, market or {}
    lots, realized, tx_rows = _fifo(transactions)
    asset_qty, asset_variants = defaultdict(int), defaultdict(int)
    bpc_items = defaultdict(list)
    buy_qty, sell_qty = defaultdict(int), defaultdict(int)
    buy_value, sell_value = defaultdict(int), defaultdict(int)
    sell_fee_weight, sell_fee_base = defaultdict(int), defaultdict(int)
    names, contract_unallocated = {}, set()
    for item in assets:
        if item.get("is_container"):
            continue
        tid = int(item.get("type_id") or 0)
        if tid:
            if item.get('is_blueprint_copy'):
                bpc_items[tid].append(item)
            asset_qty[tid] += max(0, int(item.get("quantity") or 0))
            asset_variants[tid, bool(item.get("is_blueprint_copy"))] += max(0, int(item.get("quantity") or 0))
            names[tid] = item.get("name") or names.get(tid)
    contracts = contract_costs.attach_to_physical_assets(lots, asset_variants, contracts)
    for order in orders:
        tid, qty = int(order.get("type_id") or 0), max(0, int(order.get("volume_remain") or 0))
        price = int(order.get("price_cents") or 0)
        if not tid or not qty:
            continue
        names[tid] = order.get("name") or names.get(tid)
        if bool(order.get("is_buy_order")):
            buy_qty[tid] += qty
            escrow = order.get("escrow_cents")
            buy_value[tid] += int(escrow) if escrow is not None else price * qty
        else:
            sell_qty[tid] += qty
            sell_value[tid] += price * qty
            rate = int(order.get("broker_rate_ppm") or 0) + int(order.get("sales_tax_rate_ppm") or 0)
            if rate:
                sell_fee_weight[tid] += rate * price * qty
                sell_fee_base[tid] += price * qty
    for contract in contracts:
        tid = int(contract.get("type_id") or 0)
        if tid:
            names[tid] = contract.get("name") or names.get(tid)
            if contract.get("allocated_cost_cents") is None:
                contract_unallocated.add(tid)
    remaining_lots = {tid for tid, queue in lots.items() if queue}
    types = (set(asset_qty) | set(buy_qty) | set(sell_qty) |
             remaining_lots | set(contract_unallocated))
    alerts, rows, inventory_value, unrealized = [], [], 0, 0
    for tid in sorted(types):
        metric = dict(metrics.market_metrics(history.get(tid, history.get(str(tid), []))))
        market_row = market.get(tid, market.get(str(tid), {}))
        metric.update({k: int(v or 0) for k, v in market_row.items()})
        median = metric.get("current_sell_cents") or metric.get("median_cents") or 0
        daily_volume = metric.get("daily_volume")
        queue = lots.get(tid, ())
        lot_sources = {lot.get("source") for lot in queue}
        lot_qty = sum(lot["quantity"] for lot in queue)
        contract_qty = sum(lot["quantity"] for lot in queue if lot["source"] == "contract")
        held = max(asset_qty[tid], sell_qty[tid])
        known_qty = min(held, lot_qty)
        lot_cost = sum(lot["cost_cents"] for lot in queue)
        avg_cost = (lot_cost + lot_qty // 2) // lot_qty if lot_qty else 0
        cost_basis = avg_cost * known_qty
        cost_fallback = bool(not median and held and known_qty == held and lot_qty)
        valuation_price = median if median else avg_cost if cost_fallback else None
        bpc_estimated = False
        if bpc_items[tid]:
            # Do not apply the BPO market quote to copies sharing its type ID.
            # Mixed BPO/BPC rows remain unestimated until separated by instance.
            estimates = [bpc_value_cents(item.get('product_value_per_run_cents'),
                         item.get('materials_per_run_cents'), item.get('runs'))
                         for item in bpc_items[tid]]
            bpc_estimated = (not asset_variants[tid, False] and
                             all(v is not None for v in estimates))
            median, cost_fallback = 0, False
            valuation_price = None
            if bpc_estimated and asset_qty[tid]:
                valuation_price = sum(v * max(0, int(item.get('quantity') or 0))
                                      for v, item in zip(estimates, bpc_items[tid])) // asset_qty[tid]
        listed = min(held, sell_qty[tid])
        listed_value = (sell_value[tid] * listed // sell_qty[tid]) if sell_qty[tid] else 0
        value = listed_value + max(0, held - listed) * int(valuation_price or 0)
        if bpc_estimated and not listed:
            # Sum instance values exactly: average unit rounding must not lose cents.
            value = sum(v * max(0, int(item.get('quantity') or 0))
                        for v, item in zip(estimates, bpc_items[tid]))
        value_known = listed == held or valuation_price is not None
        unvalued = bool(held and not value_known)
        gross_market = held * int(valuation_price or 0)
        latent = value - cost_basis if known_qty == held and value_known else None
        sell_rate = (sell_fee_weight[tid] // sell_fee_base[tid]) if sell_fee_base[tid] else int(metric.get("sell_fee_rate_ppm") or 0)
        projected = (gross_market - _fee(gross_market, sell_rate) - cost_basis
                     if known_qty == held and
                     (not held or valuation_price is not None) else None)
        margin_bp = projected * 10000 // gross_market if gross_market and projected is not None else None
        net_listed_value = sell_value[tid] - _fee(sell_value[tid], sell_rate)
        under_cost = bool(known_qty == held and avg_cost and sell_qty[tid] and
                          net_listed_value < avg_cost * sell_qty[tid])
        unlisted = bool(held and not sell_qty[tid])
        illiquid = bool(held and metric.get("history_available") and
                        daily_volume < ILLIQUID_DAILY_VOLUME)
        rising = bool(known_qty == held and held and avg_cost and median and
                      median * 10000 >= avg_cost * (10000 + RISE_BP))
        action = "HOLD" if under_cost else "LIST" if unlisted else "SELL" if rising else "RISK" if illiquid else "WATCH"
        name = names.get(tid) or f"Item #{tid}"
        if under_cost:
            alerts.append(metrics.alert(0, "HOLD", tid, name,
                                 "Vente nette de frais sous le coût FIFO",
                                 avg_cost * sell_qty[tid] - net_listed_value))
        if unlisted:
            alerts.append(metrics.alert(1, "LIST", tid, name,
                                 "Stock détenu sans ordre de vente",
                                 value if value_known else None))
        if illiquid:
            alerts.append(metrics.alert(2, "RISK", tid, name, f"Liquidité faible : {daily_volume}/jour", value))
        if rising:
            alerts.append(metrics.alert(1, "SELL", tid, name, "Marché au-dessus du coût FIFO +10 %", projected))
        if tid in contract_unallocated or cost_fallback:
            alerts.append(metrics.alert(1, "REVALUE", tid, name,
                                 "Marché indisponible : coût d'acquisition utilisé",
                                 lot_cost if avg_cost else None))
        inventory_value += value
        unrealized += latent or 0
        rows.append({
            "type_id": str(tid), "name": name, "quantity": held,
            "asset_qty": asset_qty[tid], "sell_qty": sell_qty[tid], "buy_qty": buy_qty[tid],
            "avg_cost_cents": _money(avg_cost) if lot_qty else None,
            "market_median_cents": _money(median) if median else None,
            "valuation_price_cents": (_money(valuation_price)
                                       if valuation_price is not None else None),
            "market_p75_cents": (_money(metric.get("p75_cents"))
                                  if metric.get("p75_cents") else None),
            "inventory_value_cents": _money(value),
            "valuation_unavailable": unvalued,
            "cost_basis_cents": _money(cost_basis) if known_qty == held else None,
            "unrealized_pnl_cents": _money(latent) if latent is not None else None,
            "projected_profit_cents": _money(projected) if projected is not None else None,
            "buy_exposure_cents": _money(buy_value[tid]), "margin_bp": margin_bp,
            "daily_volume": daily_volume, "cost_known": known_qty == held,
            "valuation_region_id": metric.get("valuation_region_id"),
            "market_source": ("zero_unvalued" if unvalued else
                              "bpc_manufacturing_margin" if bpc_estimated else
                              "cost_fallback" if cost_fallback else
                              "forge_fallback" if metric.get("forge_fallback") else
                              "regional_history" if metric.get("history_available") else
                              "unavailable"),
            "sell_fee_rate_ppm": sell_rate, "fee_known": bool(sell_rate),
            "projected_fees_cents": (_money(_fee(gross_market, sell_rate))
                                      if sell_rate and valuation_price is not None else None),
            "action": action,
            "contract_valuation_only": "contract" in lot_sources,
            "acquisition_source": ("Contrat · valorisation uniquement" if lot_sources == {"contract"} else
                                   "Marché + contrat (valorisation)" if "contract" in lot_sources else
                                   "Marché" if lot_sources else "Inconnue"),
        })
    rows.sort(key=lambda row: int(row["projected_profit_cents"] or 0), reverse=True)
    alerts.sort(key=lambda row: (row.pop("_rank"), -abs(int(row["value_cents"] or 0))))
    escrow = sum(buy_value.values())
    inventory_complete = all(row["inventory_value_cents"] is not None for row in rows)
    unrealized_complete = all(row["unrealized_pnl_cents"] is not None for row in rows)
    # A legacy sale can lack its local purchase lot.  It makes that row
    # unavailable, not every covered FIFO sale in the portfolio.
    sell_rows = [row for row in tx_rows if row["side"] == "SELL"]
    covered_sales = [row for row in sell_rows if row["cost_known"]]
    realized_available = not sell_rows or bool(covered_sales)
    summary = {"cash_cents": _money(cash_cents),
               "unvalued_types": sum(bool(row['valuation_unavailable']) for row in rows),
               "inventory_value_cents": _money(inventory_value) if inventory_complete else None,
               "buy_escrow_cents": _money(escrow),
               "fund_value_cents": (_money(int(cash_cents) + inventory_value + escrow)
                                    if inventory_complete else None),
               "realized_pnl_cents": (_money(realized)
                                       if realized_available else None),
               "unrealized_pnl_cents": _money(unrealized) if unrealized_complete else None,
               "days_running": metrics.days_running(transactions),
               "monthly_return_bp": (metrics.trailing_realized_return_bp(covered_sales)
                                     if covered_sales else None)}
    return {"ok": True, "source_label": source_label, "summary": summary,
            "assets": rows, "transactions": tx_rows, "alerts": alerts,
            "winners": rows[:3], "losers": sorted(rows, key=lambda r: int(r["projected_profit_cents"] or 0))[:3]}
