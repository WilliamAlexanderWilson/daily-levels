"""Day-by-day replay: for each day with enough prior history, compute that
day's levels using only data up to and including that day's close. The
no-lookahead guarantee lives entirely in the slice on line ~30 - every
other function downstream just sees whatever DataFrame it's handed.
"""

from dataclasses import dataclass

import pandas as pd

import config
from src.backtest.engine import build_levels_for_day


@dataclass
class DaySnapshot:
    date: pd.Timestamp
    price: float
    levels: list[dict]


def replay_levels(candles_1d: pd.DataFrame) -> list[DaySnapshot]:
    """candles_1d must be sorted ascending by date. Returns one snapshot per
    replayable day - every day with at least max(RANGE_DAYS,
    PIVOT_LOOKBACK_DAYS) days of prior daily candles available.
    """
    min_lookback_days = max(config.RANGE_DAYS, config.PIVOT_LOOKBACK_DAYS)

    snapshots = []
    for i in range(len(candles_1d)):
        day_date = candles_1d.index[i]
        history_start = day_date - pd.Timedelta(days=min_lookback_days)
        if candles_1d.index[0] > history_start:
            continue  # not enough prior history yet for this day

        # The no-lookahead guarantee: only rows up to and including day i.
        candles_up_to_day = candles_1d.iloc[: i + 1]

        levels = build_levels_for_day(candles_up_to_day)
        price = float(candles_up_to_day["close"].iloc[-1])
        snapshots.append(DaySnapshot(date=day_date, price=price, levels=levels))

    return snapshots
