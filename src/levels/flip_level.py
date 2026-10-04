"""Flip ("must hold") levels: old resistance/support that price has broken
and is now using the other way around."""

from dataclasses import dataclass

import pandas as pd

from src.levels.pivots import Pivot


@dataclass
class FlipLevel:
    price: float
    date: pd.Timestamp
    kind: str  # "support" (old resistance, now holding from below)
    # or "resistance" (old support, now capping from above)


def find_flip_levels(
    pivots: list[Pivot], daily_candles: pd.DataFrame, current_price: float
) -> dict[str, FlipLevel | None]:
    """flip_support: nearest prior pivot high that price has since closed
    above and that now sits below current price (old resistance -> support).

    flip_resistance: the mirror case — nearest prior pivot low that price
    has since closed below and that now sits above current price (old
    support -> resistance).
    """
    support_candidates: list[Pivot] = []
    resistance_candidates: list[Pivot] = []

    for pivot in pivots:
        closes_after = daily_candles.loc[daily_candles.index > pivot.date, "close"]
        if closes_after.empty:
            continue

        if pivot.kind == "high":
            if (closes_after > pivot.price).any() and current_price > pivot.price:
                support_candidates.append(pivot)
        else:
            if (closes_after < pivot.price).any() and current_price < pivot.price:
                resistance_candidates.append(pivot)

    flip_support = None
    if support_candidates:
        nearest = max(support_candidates, key=lambda p: p.price)
        flip_support = FlipLevel(price=nearest.price, date=nearest.date, kind="support")

    flip_resistance = None
    if resistance_candidates:
        nearest = min(resistance_candidates, key=lambda p: p.price)
        flip_resistance = FlipLevel(price=nearest.price, date=nearest.date, kind="resistance")

    return {"flip_support": flip_support, "flip_resistance": flip_resistance}
