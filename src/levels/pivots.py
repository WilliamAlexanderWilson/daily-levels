"""Swing pivot detection on daily candles."""

from dataclasses import dataclass

import pandas as pd

from config import PIVOT_N


@dataclass
class Pivot:
    date: pd.Timestamp
    price: float
    kind: str  # "high" or "low"


def find_pivots(candles: pd.DataFrame, n: int = PIVOT_N) -> list[Pivot]:
    """Find pivot highs/lows: a candle whose high (low) is the strict
    extreme among the n candles on each side of it.

    Candles within n of either edge can't be evaluated (not enough
    neighbors) and are skipped.
    """
    highs = candles["high"].to_numpy()
    lows = candles["low"].to_numpy()
    dates = candles.index

    pivots: list[Pivot] = []
    for i in range(n, len(candles) - n):
        window_highs = highs[i - n : i + n + 1]
        if highs[i] == window_highs.max() and (window_highs == highs[i]).sum() == 1:
            pivots.append(Pivot(date=dates[i], price=float(highs[i]), kind="high"))

        window_lows = lows[i - n : i + n + 1]
        if lows[i] == window_lows.min() and (window_lows == lows[i]).sum() == 1:
            pivots.append(Pivot(date=dates[i], price=float(lows[i]), kind="low"))

    pivots.sort(key=lambda p: p.date)
    return pivots
