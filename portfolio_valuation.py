"""Conservative manufacturing-margin estimate, in exact integer cents.

Inputs must be supplied from known product/material prices and remaining runs.
None means unestimable, distinct from a known zero manufacturing margin.
This is not a guaranteed contract sale price or a manufacturing profit quote.
"""


def bpc_value_cents(product_per_run, materials_per_run, runs):
    if any(value is None for value in (product_per_run, materials_per_run, runs)):
        return None
    product, materials, remaining = int(product_per_run), int(materials_per_run), int(runs)
    if min(product, materials, remaining) < 0:
        return None
    return max(0, product - materials) * remaining
