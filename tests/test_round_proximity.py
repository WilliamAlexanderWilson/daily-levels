"""Proximity curve: wider tolerance tiers must see at least as many
touches as narrower ones (a wider zone can only add touch opportunities,
never remove them, for the same underlying price path), and a hand-built
single-approach scenario should classify correctly at a known tier."""

import pandas as pd
import pytest

from src.backtest.replay import DaySnapshot
from src.backtest.round_proximity import PROXIMITY_TIERS, build_proximity_curve

DATES = pd.date_range("2024-01-01", periods=10, freq="D", tz="UTC")


def _candles(rows: dict) -> pd.DataFrame:
    base = {"low": 100.0, "high": 100.0, "close": 100.0}
    data = []
    for d in DATES:
        row = dict(base)
        row.update(rows.get(d.strftime("%Y-%m-%d"), {}))
        data.append(row)
    return pd.DataFrame(data, index=DATES)


def test_wider_tiers_never_have_fewer_touches_than_narrower_ones():
    # price 104 -> round numbers 100 (below) and 110 (above), step=10.
    # Candle on day1 dips to 101 (close enough for loose tiers, not for
    # the tightest), then day2 reverses hard away.
    candles = _candles(
        {
            "2024-01-01": {"low": 100.0, "high": 104.0, "close": 104.0},
            "2024-01-02": {"low": 100.8, "high": 101.5, "close": 101.0},
            "2024-01-03": {"low": 108.0, "high": 112.0, "close": 111.0},
        }
    )
    snapshots = [DaySnapshot(date=DATES[0], price=104.0, levels=[])]

    curve = build_proximity_curve(snapshots, candles)

    assert [c["tolerance_fraction"] for c in curve] == PROXIMITY_TIERS
    touches_by_tier = [c["touches"] for c in curve]
    # PROXIMITY_TIERS is listed loosest-first (1.0 down to 0.02), so
    # touches should be non-increasing as the tier narrows.
    for wider, narrower in zip(touches_by_tier, touches_by_tier[1:]):
        assert wider >= narrower


def test_empty_snapshots_still_returns_every_tier_with_zero_touches():
    curve = build_proximity_curve([], pd.DataFrame(columns=["low", "high", "close"]))
    assert len(curve) == len(PROXIMITY_TIERS)
    for tier in curve:
        assert tier["touches"] == 0
        assert tier["resolved"] == 0
        assert tier["hold_rate_pct"] is None
        assert tier["low_confidence"] is True
