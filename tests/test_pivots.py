"""Hand-verifiable pivot detection: a single clear pivot high and pivot
low, each the unique extreme within PIVOT_N=5 candles on each side."""

import pandas as pd

from src.levels.pivots import find_pivots

HIGHS = [50, 51, 52, 53, 54, 53, 54, 55, 56, 70, 56, 55, 54, 53, 52, 51, 50]
LOWS = [40, 39, 38, 37, 36, 20, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46]
DATES = pd.date_range("2024-01-01", periods=len(HIGHS), freq="D", tz="UTC")

CANDLES = pd.DataFrame(
    {
        "high": HIGHS,
        "low": LOWS,
        "open": LOWS,
        "close": HIGHS,
    },
    index=DATES,
)


def test_finds_the_one_pivot_high_and_one_pivot_low():
    pivots = find_pivots(CANDLES, n=5)

    highs = [p for p in pivots if p.kind == "high"]
    lows = [p for p in pivots if p.kind == "low"]

    assert len(highs) == 1
    assert highs[0].price == 70
    assert highs[0].date == DATES[9]

    assert len(lows) == 1
    assert lows[0].price == 20
    assert lows[0].date == DATES[5]


def test_pivots_are_sorted_by_date():
    pivots = find_pivots(CANDLES, n=5)
    assert pivots == sorted(pivots, key=lambda p: p.date)


def test_too_short_series_has_no_pivots():
    short = CANDLES.iloc[:8]
    assert find_pivots(short, n=5) == []
