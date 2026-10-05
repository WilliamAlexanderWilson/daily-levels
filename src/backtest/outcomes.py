"""Touch/hold/break classification for one level snapshot against the
daily candles that follow it.

Definitions (spec): a level is "touched" if price trades into its zone
within the forward window. Once touched, scanning forward from the touch
day: "hold" if price closes BACKTEST_HOLD_MOVE_PCT away from the level's
midpoint before any close lands BACKTEST_BREAK_CLOSE_PCT beyond it on the
other side; "break" if the reverse happens first. Direction ("away" vs
"beyond") is relative to the level's type at computation time - support
defends from below (away = up, beyond = down), resistance defends from
above (away = down, beyond = up). If neither condition resolves within the
forward window, the touch is "inconclusive" and excluded from the hold
rate (not enough information either way, not a third outcome).
"""

from dataclasses import dataclass

import pandas as pd

import config


@dataclass
class Outcome:
    touched: bool
    result: str | None  # "hold", "break", "inconclusive", or None if never touched
    move_pct: float | None  # % move from the level's midpoint at resolution


def classify_outcome(level: dict, future_candles: pd.DataFrame) -> Outcome:
    """future_candles: daily candles strictly after the day the level was
    computed, in order, already clipped to whatever history is actually
    available (may be shorter than BACKTEST_FORWARD_DAYS near the end of
    the dataset)."""
    if future_candles.empty:
        return Outcome(touched=False, result=None, move_pct=None)

    low, high = level["price_low"], level["price_high"]
    mid = (low + high) / 2
    is_support = level["type"] == "support"

    touch_idx = None
    for i in range(len(future_candles)):
        row = future_candles.iloc[i]
        if row["low"] <= high and row["high"] >= low:
            touch_idx = i
            break

    if touch_idx is None:
        return Outcome(touched=False, result=None, move_pct=None)

    hold_threshold = mid * (1 + config.BACKTEST_HOLD_MOVE_PCT / 100) if is_support else mid * (
        1 - config.BACKTEST_HOLD_MOVE_PCT / 100
    )
    break_threshold = mid * (1 - config.BACKTEST_BREAK_CLOSE_PCT / 100) if is_support else mid * (
        1 + config.BACKTEST_BREAK_CLOSE_PCT / 100
    )

    for i in range(touch_idx, len(future_candles)):
        close = future_candles.iloc[i]["close"]
        held = close >= hold_threshold if is_support else close <= hold_threshold
        broke = close <= break_threshold if is_support else close >= break_threshold

        if held:
            return Outcome(touched=True, result="hold", move_pct=(close - mid) / mid * 100)
        if broke:
            return Outcome(touched=True, result="break", move_pct=(close - mid) / mid * 100)

    return Outcome(touched=True, result="inconclusive", move_pct=None)


def forward_window(candles_1d: pd.DataFrame, after_date: pd.Timestamp) -> pd.DataFrame:
    """The up-to-BACKTEST_FORWARD_DAYS daily candles strictly after after_date."""
    future = candles_1d[candles_1d.index > after_date]
    return future.iloc[: config.BACKTEST_FORWARD_DAYS]
