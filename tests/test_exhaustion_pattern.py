"""Hand-constructed Heikin-Ashi sequences exercising the daily exhaustion
rule directly (TREND_LOOKBACK=3, DOJI_BODY_MAX_PCT=0.30), the same way
tests/test_spy_exhaustion_signal.py does for the SPY version - bypassing
the real-OHLC conversion so the wick/body math is exactly traceable (HA
open is a running recursive average of all prior history, so it can't be
hand-derived from just a few real rows).

Downtrend-exhaustion scenario (daily candles):
  c0 108.8-110.2, O=110 C=109   (down, range=1.4)
  c1 107.8-109.2, O=109 C=108   (down, range=1.4)
  c2 106.8-108.2, O=108 C=107   (down, range=1.4)
  c3 104.5-107.1, O=107 C=106.9 (small body=0.1, range=2.6, body_pct=0.038 -> doji)
     lower_wick = min(107,106.9) - 104.5 = 2.4   > every trend candle's range (1.4) -> qualifies
     upper_wick = 107.1 - 107 = 0.1              (not the relevant side)
  Preceding trend was down -> expected direction = "bullish_reversal".
"""

import pandas as pd
import pytest

from src.backtest.exhaustion_pattern import build_exhaustion_scorecard_entry
from src.levels.exhaustion_pattern import (
    DOJI_BODY_MAX_PCT,
    TREND_LOOKBACK,
    _find_in_ha_frame,
    detect_latest,
    find_exhaustion_days,
)

HA_COLUMNS = ["ha_open", "ha_high", "ha_low", "ha_close"]


def _ha_frame(rows, start="2026-01-01"):
    idx = pd.date_range(start, periods=len(rows), freq="1D", tz="UTC")
    return pd.DataFrame(rows, index=idx, columns=HA_COLUMNS)


DOWNTREND_EXHAUSTION = [
    [110.0, 110.2, 108.8, 109.0],
    [109.0, 109.2, 107.8, 108.0],
    [108.0, 108.2, 106.8, 107.0],
    [107.0, 107.1, 104.5, 106.9],
]

UPTREND_EXHAUSTION = [
    [100.0, 101.2, 99.8, 101.0],
    [101.0, 102.2, 100.8, 102.0],
    [102.0, 103.2, 101.8, 103.0],
    [103.0, 105.5, 102.9, 103.1],
]


def test_constants_match_scenario_assumptions():
    assert TREND_LOOKBACK == 3
    assert DOJI_BODY_MAX_PCT == pytest.approx(0.30)


def test_downtrend_exhaustion_fires_bullish_reversal():
    frame = _ha_frame(DOWNTREND_EXHAUSTION)
    results = _find_in_ha_frame(frame)
    assert len(results) == 1
    assert results[0].direction == "bullish_reversal"
    assert results[0].idx == 3


def test_uptrend_exhaustion_fires_bearish_reversal():
    frame = _ha_frame(UPTREND_EXHAUSTION)
    results = _find_in_ha_frame(frame)
    assert len(results) == 1
    assert results[0].direction == "bearish_reversal"


def test_doji_with_wrong_side_wick_does_not_qualify():
    rows = DOWNTREND_EXHAUSTION[:3] + [[107.0, 109.5, 106.9, 107.1]]
    frame = _ha_frame(rows)
    assert _find_in_ha_frame(frame) == []


def test_non_doji_body_does_not_qualify():
    rows = DOWNTREND_EXHAUSTION[:3] + [[107.0, 107.1, 103.0, 104.0]]
    frame = _ha_frame(rows)
    assert _find_in_ha_frame(frame) == []


def test_broken_trend_run_does_not_qualify():
    # c1 is up instead of down - no clean 3-candle run precedes the doji.
    rows = [
        [110.0, 110.2, 108.8, 109.0],
        [109.0, 110.5, 108.9, 110.3],  # up, breaks the run
        [108.0, 108.2, 106.8, 107.0],
        [107.0, 107.1, 104.5, 106.9],
    ]
    frame = _ha_frame(rows)
    assert _find_in_ha_frame(frame) == []


def _strong_trend_real_candles(direction: str, n_trend: int) -> pd.DataFrame:
    """A real-OHLC series engineered to produce an obvious, clean HA trend
    followed by a hammer/shooting-star-shaped exhaustion candle, so
    find_exhaustion_days (the real-OHLC entry point, going through
    to_heikin_ashi) can be tested against something other than hand-built HA
    rows. Tuned numerically (see the commit this test was added in) rather
    than by a simple formula: HA close averages in the WHOLE real candle
    (open+high+low+close)/4, so a merely-long wick isn't enough to produce a
    small HA body on its own - the opposite side (close snapping back past
    the open, not just near it) has to counterbalance the wick's pull on the
    average for ha_close to land back near ha_open."""
    rows = []
    price = 100.0
    step = 2.0 if direction == "down" else -2.0
    for _ in range(n_trend):
        o = price
        c = price - step if direction == "down" else price + step
        high = max(o, c) + 0.1
        low = min(o, c) - 0.1
        rows.append({"open": o, "high": high, "low": low, "close": c, "volume": 100.0})
        price = c

    if direction == "down":
        # A hammer: opens near the trend's last close, wicks far below, then
        # snaps back up well past the open.
        rows.append({"open": price, "high": price + 8.2, "low": price - 5.0, "close": price + 8.0, "volume": 100.0})
    else:
        # A shooting star: the mirror image.
        rows.append({"open": price, "high": price + 5.0, "low": price - 8.2, "close": price - 8.0, "volume": 100.0})

    idx = pd.date_range("2024-01-01", periods=len(rows), freq="1D", tz="UTC")
    return pd.DataFrame(rows, index=idx)


def test_find_exhaustion_days_through_real_ohlc_conversion():
    candles = _strong_trend_real_candles("down", n_trend=TREND_LOOKBACK + 2)
    results = find_exhaustion_days(candles)
    assert len(results) >= 1
    assert results[-1].direction == "bullish_reversal"
    assert results[-1].idx == len(candles) - 1


def test_detect_latest_matches_last_candle():
    candles = _strong_trend_real_candles("down", n_trend=TREND_LOOKBACK + 2)
    detected = detect_latest(candles)
    assert detected is not None
    assert detected["direction"] == "bullish_reversal"

    # Appending one more ordinary candle after the exhaustion day means the
    # pattern no longer sits on the LATEST candle - detect_latest should
    # report nothing then, even though find_exhaustion_days still finds it
    # historically.
    extra_idx = candles.index[-1] + pd.Timedelta(days=1)
    extra_row = pd.DataFrame(
        [{"open": candles.iloc[-1]["close"], "high": candles.iloc[-1]["close"] + 1,
          "low": candles.iloc[-1]["close"] - 1, "close": candles.iloc[-1]["close"] + 0.5, "volume": 100.0}],
        index=[extra_idx],
    )
    extended = pd.concat([candles, extra_row])
    assert detect_latest(extended) is None
    assert len(find_exhaustion_days(extended)) >= 1


def test_scorecard_entry_shape_and_low_confidence_flag():
    candles = _strong_trend_real_candles("down", n_trend=TREND_LOOKBACK + 2)
    entry = build_exhaustion_scorecard_entry(candles)
    assert set(entry.keys()) == {
        "touches", "resolved", "holds", "breaks", "inconclusive",
        "hold_rate_pct", "avg_move_after_hold_pct", "avg_move_after_break_pct",
        "low_confidence",
    }
    # Only one occurrence in this tiny fixture and it's the very last candle,
    # so there's zero forward data to resolve it - not a sample at all.
    assert entry["touches"] == 0
    assert entry["low_confidence"] is True
