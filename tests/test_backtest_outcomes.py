"""Hand-verifiable touch/hold/break classification.

Thresholds for a level with mid=100:
  support:    hold >= 102 (mid * 1.02),  break <= 99  (mid * 0.99)
  resistance: hold <= 196 (mid * 0.98),  break >= 202 (mid * 1.01)
  (mid=200 for the resistance examples below)
"""

import pandas as pd
import pytest

from src.backtest.outcomes import classify_outcome, forward_window

SUPPORT = {"price_low": 100.0, "price_high": 100.0, "type": "support"}
RESISTANCE = {"price_low": 200.0, "price_high": 200.0, "type": "resistance"}


def _candles(rows: list[tuple[float, float, float]]) -> pd.DataFrame:
    return pd.DataFrame(rows, columns=["low", "high", "close"])


def test_support_touch_then_hold():
    future = _candles(
        [
            (99.5, 100.5, 100.2),  # touches, resolves neither yet
            (102.5, 103.5, 103.0),  # close=103 >= 102 -> hold
        ]
    )
    outcome = classify_outcome(SUPPORT, future)
    assert outcome.touched is True
    assert outcome.result == "hold"
    assert outcome.move_pct == pytest.approx(3.0)


def test_support_touch_then_break():
    future = _candles(
        [
            (99.0, 100.5, 99.5),  # touches, resolves neither yet
            (98.0, 99.0, 98.5),  # close=98.5 <= 99 -> break
        ]
    )
    outcome = classify_outcome(SUPPORT, future)
    assert outcome.touched is True
    assert outcome.result == "break"
    assert outcome.move_pct == pytest.approx(-1.5)


def test_resistance_touch_then_hold():
    future = _candles(
        [
            (199.5, 201.0, 200.5),  # touches
            (194.0, 196.0, 195.0),  # close=195 <= 196 -> hold
        ]
    )
    outcome = classify_outcome(RESISTANCE, future)
    assert outcome.touched is True
    assert outcome.result == "hold"
    assert outcome.move_pct == pytest.approx(-2.5)


def test_resistance_touch_then_break():
    future = _candles(
        [
            (199.0, 200.5, 200.0),  # touches
            (202.0, 204.0, 203.0),  # close=203 >= 202 -> break
        ]
    )
    outcome = classify_outcome(RESISTANCE, future)
    assert outcome.touched is True
    assert outcome.result == "break"
    assert outcome.move_pct == pytest.approx(1.5)


def test_never_touched():
    future = _candles([(110.0, 115.0, 112.0), (111.0, 116.0, 113.0)])
    outcome = classify_outcome(SUPPORT, future)
    assert outcome.touched is False
    assert outcome.result is None
    assert outcome.move_pct is None


def test_touched_but_inconclusive_within_window():
    # stays in the dead zone between break (99) and hold (102) the whole time
    future = _candles([(99.5, 100.5, 100.0), (99.8, 100.6, 100.3)])
    outcome = classify_outcome(SUPPORT, future)
    assert outcome.touched is True
    assert outcome.result == "inconclusive"
    assert outcome.move_pct is None


def test_empty_future_is_not_touched():
    outcome = classify_outcome(SUPPORT, _candles([]))
    assert outcome.touched is False
    assert outcome.result is None


def test_forward_window_excludes_the_day_itself_and_caps_length():
    dates = pd.date_range("2024-01-01", periods=20, freq="D", tz="UTC")
    candles = pd.DataFrame({"close": range(20)}, index=dates)

    window = forward_window(candles, dates[5])

    assert len(window) == 10  # BACKTEST_FORWARD_DAYS
    assert window.index[0] == dates[6]  # strictly after, not including day 5
    assert window.index[-1] == dates[15]


def test_forward_window_shrinks_near_the_end_of_data():
    dates = pd.date_range("2024-01-01", periods=10, freq="D", tz="UTC")
    candles = pd.DataFrame({"close": range(10)}, index=dates)

    window = forward_window(candles, dates[7])

    assert len(window) == 2  # only 2 days left after dates[7]
