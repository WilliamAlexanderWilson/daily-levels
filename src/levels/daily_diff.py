"""Compares today's levels to the most recent prior snapshot and tags each
named level kind as new, moved, unchanged, or removed.

A level's output price is only ever a merged zone's [price_low,
price_high] - the pre-merge price of an individual constituent isn't
retained. For diffing, each constituent kind's price is reconstructed as
the midpoint of whichever merged zone it belongs to that day. Two kinds
merged together on one day and separate the next still diff cleanly under
this scheme, since each kind is tracked independently.
"""

import config


def extract_kind_prices(levels: list[dict]) -> dict[str, float]:
    """Maps each constituent level name (a merged level's label split on
    " + ") to its zone's midpoint price."""
    prices = {}
    for level in levels:
        mid = (level["price_low"] + level["price_high"]) / 2
        for kind in level["name"].split(" + "):
            prices[kind] = mid
    return prices


def compute_diff(
    today_levels: list[dict],
    previous_levels: list[dict] | None,
    move_threshold_pct: float = config.DAILY_DIFF_MOVE_THRESHOLD_PCT,
) -> list[dict]:
    """Returns one entry per level kind seen today or in the previous
    snapshot: {kind, status, old_price, new_price, change_pct}.

    status is "new" (no previous snapshot to compare against counts
    everything as new - there's nothing to diff against on the very first
    run), "moved", "unchanged", or "removed".
    """
    today_prices = extract_kind_prices(today_levels)

    if previous_levels is None:
        return [
            {"kind": kind, "status": "new", "old_price": None, "new_price": price, "change_pct": None}
            for kind, price in sorted(today_prices.items())
        ]

    previous_prices = extract_kind_prices(previous_levels)
    all_kinds = sorted(set(today_prices) | set(previous_prices))

    diff = []
    for kind in all_kinds:
        new_price = today_prices.get(kind)
        old_price = previous_prices.get(kind)

        if new_price is not None and old_price is None:
            diff.append({"kind": kind, "status": "new", "old_price": None, "new_price": new_price, "change_pct": None})
        elif new_price is None and old_price is not None:
            diff.append({"kind": kind, "status": "removed", "old_price": old_price, "new_price": None, "change_pct": None})
        else:
            change_pct = (new_price - old_price) / old_price * 100
            status = "moved" if abs(change_pct) > move_threshold_pct else "unchanged"
            diff.append(
                {"kind": kind, "status": status, "old_price": old_price, "new_price": new_price, "change_pct": change_pct}
            )

    return diff
