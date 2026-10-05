"""Hand-verifiable scorecard aggregation: a confluence-merged level's
outcome is attributed to each of its constituent named levels."""

import pandas as pd
import pytest

from src.backtest.replay import DaySnapshot
from src.backtest.scorecard import build_scorecard

DATES = pd.date_range("2024-01-10", periods=13, freq="D", tz="UTC")
# 01-10 .. 01-22

NEUTRAL = {"open": 150.0, "high": 150.5, "low": 149.5, "close": 150.0, "volume": 1.0}

OVERRIDES = {
    "2024-01-11": {"low": 99.5, "high": 100.5, "close": 100.2},  # touches 100-support
    "2024-01-12": {"low": 102.5, "high": 103.5, "close": 103.0},  # resolves hold (+3.0%)
    "2024-01-21": {"low": 199.0, "high": 200.5, "close": 200.0},  # touches 200-resistance
    "2024-01-22": {"low": 202.0, "high": 204.0, "close": 203.0},  # resolves break (+1.5%)
}


def _candles() -> pd.DataFrame:
    rows = []
    for d in DATES:
        row = dict(NEUTRAL)
        row.update(OVERRIDES.get(d.strftime("%Y-%m-%d"), {}))
        rows.append(row)
    return pd.DataFrame(rows, index=DATES)


def test_merged_level_outcome_credited_to_each_constituent():
    candles = _candles()

    day1 = DaySnapshot(
        date=pd.Timestamp("2024-01-10", tz="UTC"),
        price=150.0,
        levels=[
            {"name": "POC (60d)", "price_low": 100.0, "price_high": 100.0, "type": "support", "strength": 1, "is_flip": False}
        ],
    )
    day2 = DaySnapshot(
        date=pd.Timestamp("2024-01-20", tz="UTC"),
        price=150.0,
        levels=[
            {
                "name": "POC (60d) + Prior month low",
                "price_low": 200.0,
                "price_high": 200.0,
                "type": "resistance",
                "strength": 2,
                "is_flip": False,
            }
        ],
    )

    scorecard = build_scorecard([day1, day2], candles)

    poc = scorecard["POC (60d)"]
    assert poc["touches"] == 2
    assert poc["holds"] == 1
    assert poc["breaks"] == 1
    assert poc["resolved"] == 2
    assert poc["hold_rate_pct"] == pytest.approx(50.0)
    assert poc["avg_move_after_hold_pct"] == pytest.approx(3.0)
    assert poc["avg_move_after_break_pct"] == pytest.approx(1.5)
    assert poc["low_confidence"] is True  # resolved=2 < BACKTEST_MIN_TOUCHES_CONFIDENT

    prior_month_low = scorecard["Prior month low"]
    assert prior_month_low["touches"] == 1
    assert prior_month_low["holds"] == 0
    assert prior_month_low["breaks"] == 1
    assert prior_month_low["hold_rate_pct"] == pytest.approx(0.0)
    assert prior_month_low["avg_move_after_hold_pct"] is None
    assert prior_month_low["avg_move_after_break_pct"] == pytest.approx(1.5)


def test_empty_snapshots_produce_empty_scorecard():
    assert build_scorecard([], pd.DataFrame(columns=["low", "high", "close"])) == {}
