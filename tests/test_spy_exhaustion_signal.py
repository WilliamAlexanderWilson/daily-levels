"""Hand-constructed Heikin-Ashi sequences exercising the exhaustion rule
directly (TREND_LOOKBACK=4, DOJI_BODY_MAX_PCT=0.30), bypassing the real-OHLC
conversion so the wick/body math is exactly traceable.

Downtrend-exhaustion scenario (candles at 10:00/10:10/10:20/10:30/10:40 ET):
  c0 108.8-110.2, O=110 C=109   (down, range=1.4)
  c1 107.8-109.2, O=109 C=108   (down, range=1.4)
  c2 106.8-108.2, O=108 C=107   (down, range=1.4)
  c3 105.8-107.2, O=107 C=106   (down, range=1.4)
  c4 103.5-106.1, O=106 C=105.9 (small body=0.1, range=2.6, body_pct=0.038 -> doji)
     lower_wick = min(106,105.9) - 103.5 = 2.4   > every trend candle's range (1.4) -> qualifies
     upper_wick = 106.1 - 106 = 0.1              (not the relevant side)
  Preceding trend was down (4 candles) -> expected direction = "call".
"""

import pandas as pd
import pytest

from src.spy.exhaustion_signal import DOJI_BODY_MAX_PCT, TREND_LOOKBACK, find_signals

ET = "America/New_York"


def _ha_frame(rows, start="2026-08-05 10:00", freq_minutes=10):
    idx = pd.date_range(start, periods=len(rows), freq=f"{freq_minutes}min", tz=ET).tz_convert("UTC")
    return pd.DataFrame(rows, index=idx, columns=["ha_open", "ha_high", "ha_low", "ha_close"])


DOWNTREND_EXHAUSTION = [
    [110.0, 110.2, 108.8, 109.0],
    [109.0, 109.2, 107.8, 108.0],
    [108.0, 108.2, 106.8, 107.0],
    [107.0, 107.2, 105.8, 106.0],
    [106.0, 106.1, 103.5, 105.9],
]

UPTREND_EXHAUSTION = [
    [100.0, 101.2, 99.8, 101.0],
    [101.0, 102.2, 100.8, 102.0],
    [102.0, 103.2, 101.8, 103.0],
    [103.0, 104.2, 102.8, 104.0],
    [104.0, 106.5, 103.9, 104.1],
]


def test_constants_match_scenario_assumptions():
    assert TREND_LOOKBACK == 4
    assert DOJI_BODY_MAX_PCT == pytest.approx(0.30)


def test_downtrend_exhaustion_fires_call_signal():
    frame = _ha_frame(DOWNTREND_EXHAUSTION)
    signals = find_signals({10: frame})
    assert len(signals) == 1
    assert signals[0].direction == "call"
    assert signals[0].n_confirmed == 1
    assert signals[0].confirmed_timeframes == [10]


def test_uptrend_exhaustion_fires_put_signal():
    frame = _ha_frame(UPTREND_EXHAUSTION)
    signals = find_signals({10: frame})
    assert len(signals) == 1
    assert signals[0].direction == "put"


def test_doji_with_wrong_side_wick_does_not_qualify():
    # Same downtrend, but the exhaustion candle's big wick is on the WRONG
    # side (upper, not lower) - trend exhaustion requires rejection at the
    # bottom of a downtrend, not the top.
    rows = DOWNTREND_EXHAUSTION[:4] + [[106.0, 108.5, 105.9, 106.1]]
    frame = _ha_frame(rows)
    signals = find_signals({10: frame})
    assert signals == []


def test_non_doji_body_does_not_qualify():
    # Same setup, but candle 5 has a large body (not a doji) despite a big wick.
    rows = DOWNTREND_EXHAUSTION[:4] + [[106.0, 106.1, 102.0, 103.0]]
    frame = _ha_frame(rows)
    signals = find_signals({10: frame})
    assert signals == []


def test_signal_outside_session_window_is_excluded():
    frame = _ha_frame(DOWNTREND_EXHAUSTION, start="2026-08-05 13:00")  # 1-4pm ET
    signals = find_signals({10: frame})
    assert signals == []


def test_multi_timeframe_confluence_counts_agreeing_directions():
    # freq_minutes picked so each frame's doji (index TREND_LOOKBACK=4) lands
    # within SIGNAL_CLUSTER_MINUTES (15) of the other's: 4*10=40min vs 4*12=48min.
    frame_a = _ha_frame(DOWNTREND_EXHAUSTION, freq_minutes=10)
    frame_b = _ha_frame(DOWNTREND_EXHAUSTION, freq_minutes=12)
    signals = find_signals({10: frame_a, 12: frame_b})
    assert len(signals) == 1
    assert signals[0].n_confirmed == 2
    assert set(signals[0].confirmed_timeframes) == {10, 12}
