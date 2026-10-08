"""Hand-verifiable Heikin-Ashi conversion and resample-anchoring checks.

HA formulas, computed by hand for a 3-bar sequence:
  bar0: O=10 H=12 L=9  C=11
  bar1: O=11 H=13 L=10 C=12
  bar2: O=12 H=12 L=8  C=9

  ha_close0 = (10+12+9+11)/4   = 10.5
  ha_open0  = (10+11)/2        = 10.5
  ha_high0  = max(12, 10.5, 10.5) = 12
  ha_low0   = min(9, 10.5, 10.5)  = 9

  ha_close1 = (11+13+10+12)/4  = 11.5
  ha_open1  = (ha_open0 + ha_close0)/2 = (10.5+10.5)/2 = 10.5
  ha_high1  = max(13, 10.5, 11.5) = 13
  ha_low1   = min(10, 10.5, 11.5) = 10

  ha_close2 = (12+12+8+9)/4    = 10.25
  ha_open2  = (ha_open1 + ha_close1)/2 = (10.5+11.5)/2 = 11.0
  ha_high2  = max(12, 11.0, 10.25) = 12
  ha_low2   = min(8, 11.0, 10.25)  = 8
"""

import pandas as pd
import pytest

from src.spy.heikin_ashi import resample_session, to_heikin_ashi


def _ohlc(rows):
    idx = pd.date_range("2026-08-05 13:30", periods=len(rows), freq="5min", tz="UTC")
    return pd.DataFrame(rows, index=idx, columns=["open", "high", "low", "close", "volume"])


def test_heikin_ashi_hand_computed():
    df = _ohlc(
        [
            [10, 12, 9, 11, 100],
            [11, 13, 10, 12, 100],
            [12, 12, 8, 9, 100],
        ]
    )
    ha = to_heikin_ashi(df)

    assert ha["ha_close"].tolist() == pytest.approx([10.5, 11.5, 10.25])
    assert ha["ha_open"].tolist() == pytest.approx([10.5, 10.5, 11.0])
    assert ha["ha_high"].tolist() == pytest.approx([12, 13, 12])
    assert ha["ha_low"].tolist() == pytest.approx([9, 10, 8])


def test_resample_anchors_to_session_start_not_midnight():
    # Session "opens" at 13:30 UTC (9:30 EDT). 10-minute bars should land on
    # 13:30, 13:40, 13:50... not on clock-aligned 13:00/13:10 boundaries.
    idx = pd.date_range("2026-08-05 13:30", periods=6, freq="5min", tz="UTC")
    df = pd.DataFrame(
        {
            "open": [1, 2, 3, 4, 5, 6],
            "high": [1, 2, 3, 4, 5, 6],
            "low": [1, 2, 3, 4, 5, 6],
            "close": [1, 2, 3, 4, 5, 6],
            "volume": [10, 10, 10, 10, 10, 10],
        },
        index=idx,
    )
    resampled = resample_session(df, 10)

    # label="right": first 10m bar covers [13:30,13:40) -> labeled 13:40.
    assert list(resampled.index.tz_convert("UTC").strftime("%H:%M")) == ["13:40", "13:50", "14:00"]
    first = resampled.iloc[0]
    assert (first["open"], first["high"], first["low"], first["close"], first["volume"]) == (1, 2, 1, 2, 20)
