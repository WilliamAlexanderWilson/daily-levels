"""Hand-verifiable golden pocket: pick the most recent *qualifying* leg
(>= 8% move) between alternating pivots, and compute its 0.618-0.65
retracement zone."""

import pandas as pd
import pytest

from src.levels.golden_pocket import find_golden_pocket
from src.levels.pivots import Pivot

D0 = pd.Timestamp("2024-01-01", tz="UTC")
D1 = pd.Timestamp("2024-01-02", tz="UTC")
D2 = pd.Timestamp("2024-01-03", tz="UTC")
D3 = pd.Timestamp("2024-01-04", tz="UTC")


def test_picks_most_recent_qualifying_leg_up():
    # leg0: 100 -> 120 (+20%) qualifies
    # leg1: 120 -> 115 (-4.17%) does NOT qualify (< 8%)
    # leg2: 115 -> 140 (+21.74%) qualifies and is the most recent
    pivots = [
        Pivot(date=D0, price=100.0, kind="low"),
        Pivot(date=D1, price=120.0, kind="high"),
        Pivot(date=D2, price=115.0, kind="low"),
        Pivot(date=D3, price=140.0, kind="high"),
    ]

    gp = find_golden_pocket(pivots, min_swing_pct=8.0)

    assert gp is not None
    assert gp.leg_start.price == 115.0
    assert gp.leg_end.price == 140.0
    assert gp.swing_pct == pytest.approx((140 - 115) / 115 * 100)
    # range = 25; up-leg -> zone = end - range*[0.618, 0.65]
    assert gp.zone_low == pytest.approx(140 - 25 * 0.65)   # 123.75
    assert gp.zone_high == pytest.approx(140 - 25 * 0.618)  # 124.55


def test_down_leg_mirrors_above_the_low():
    pivots = [
        Pivot(date=D0, price=200.0, kind="high"),
        Pivot(date=D1, price=150.0, kind="low"),
    ]

    gp = find_golden_pocket(pivots, min_swing_pct=8.0)

    assert gp is not None
    # range = 50; down-leg -> zone = end + range*[0.618, 0.65]
    assert gp.zone_low == pytest.approx(150 + 50 * 0.618)  # 180.9
    assert gp.zone_high == pytest.approx(150 + 50 * 0.65)   # 182.5


def test_no_qualifying_leg_returns_none():
    pivots = [
        Pivot(date=D0, price=100.0, kind="low"),
        Pivot(date=D1, price=105.0, kind="high"),  # only +5%, below 8% threshold
    ]
    assert find_golden_pocket(pivots, min_swing_pct=8.0) is None


def test_fewer_than_two_pivots_returns_none():
    assert find_golden_pocket([], min_swing_pct=8.0) is None
    assert find_golden_pocket([Pivot(date=D0, price=100.0, kind="low")], min_swing_pct=8.0) is None


def test_same_kind_run_collapses_to_most_extreme():
    # two lows in a row: 100 then 90 - the zigzag should keep only 90
    # (more extreme), then pair it with the following high.
    pivots = [
        Pivot(date=D0, price=100.0, kind="low"),
        Pivot(date=D1, price=90.0, kind="low"),
        Pivot(date=D2, price=130.0, kind="high"),
    ]

    gp = find_golden_pocket(pivots, min_swing_pct=8.0)

    assert gp is not None
    assert gp.leg_start.price == 90.0
    assert gp.leg_end.price == 130.0
    # range = 40
    assert gp.zone_low == pytest.approx(130 - 40 * 0.65)   # 104.0
    assert gp.zone_high == pytest.approx(130 - 40 * 0.618)  # 105.28
