"""Hand-verifiable flip ("must hold") level detection."""

import pandas as pd

from src.levels.flip_level import find_flip_levels
from src.levels.pivots import Pivot

DATES = pd.date_range("2024-01-01", periods=6, freq="D", tz="UTC")


def _daily(closes: list[float]) -> pd.DataFrame:
    return pd.DataFrame({"close": closes}, index=DATES)


def test_pivot_high_flips_to_support_once_broken():
    pivot_high = Pivot(date=DATES[1], price=150.0, kind="high")
    # closes after the pivot date: one of them (155) breaks above 150
    daily = _daily([100, 150, 140, 155, 158, 162])
    current_price = 160.0

    flips = find_flip_levels([pivot_high], daily, current_price)

    assert flips["flip_support"] is not None
    assert flips["flip_support"].price == 150.0
    assert flips["flip_resistance"] is None


def test_pivot_low_flips_to_resistance_once_broken():
    pivot_low = Pivot(date=DATES[1], price=50.0, kind="low")
    daily = _daily([80, 50, 60, 45, 42, 40])
    current_price = 40.0

    flips = find_flip_levels([pivot_low], daily, current_price)

    assert flips["flip_resistance"] is not None
    assert flips["flip_resistance"].price == 50.0
    assert flips["flip_support"] is None


def test_no_flip_if_resistance_never_broken():
    pivot_high = Pivot(date=DATES[1], price=150.0, kind="high")
    # price never closes above 150 after the pivot
    daily = _daily([100, 150, 140, 145, 148, 149])
    current_price = 160.0  # even though price is "above" 150 now, it never closed above

    flips = find_flip_levels([pivot_high], daily, current_price)
    assert flips["flip_support"] is None


def test_nearest_flip_support_chosen_among_candidates():
    low_flip = Pivot(date=DATES[0], price=120.0, kind="high")
    high_flip = Pivot(date=DATES[0], price=140.0, kind="high")
    daily = _daily([100, 150, 150, 150, 150, 150])
    current_price = 160.0

    flips = find_flip_levels([low_flip, high_flip], daily, current_price)
    # both 120 and 140 are below 160 and broken; nearest (highest) is 140
    assert flips["flip_support"].price == 140.0
