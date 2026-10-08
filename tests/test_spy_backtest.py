"""Structural/edge-case tests for trade simulation - the pricing math
itself is covered in test_spy_options_pricing.py, so these use extreme,
unambiguous underlying moves (deep ITM / deep OTM) rather than hand-rolled
Black-Scholes arithmetic: the exact premium isn't being checked, only that
the right exit path is taken.
"""

import pandas as pd
import pytest

from src.spy.backtest import _trading_days, simulate_trade
from src.spy.exhaustion_signal import Signal

ET = "America/New_York"


def _ts(s):
    return pd.Timestamp(s, tz=ET).tz_convert("UTC")


def _bar(t, close):
    return {"time": t, "open": close, "high": close, "low": close, "close": close, "volume": 1000}


def _frame(rows):
    df = pd.DataFrame(rows).set_index("time")
    return df


def _vix(dates, value=20.0):
    idx = pd.to_datetime(dates, utc=True)
    return pd.Series([value] * len(dates), index=idx)


def test_trade_incomplete_when_data_horizon_too_short():
    # Only one trading day in the dataset - "2 trading days out" can't resolve.
    signal = Signal(time=_ts("2026-08-05 10:00"), direction="call", n_confirmed=1, confirmed_timeframes=[10])
    real_5m = _frame([_bar(_ts("2026-08-05 10:00"), 100.0)])
    vix = _vix(["2026-08-05"])
    trading_days = _trading_days(real_5m)

    trade = simulate_trade(signal, real_5m, vix, trading_days)

    assert trade is not None
    assert trade.exit_reason == "incomplete"
    assert trade.pct_return is None


def test_call_hits_target_on_sharp_rally():
    signal = Signal(time=_ts("2026-08-05 10:00"), direction="call", n_confirmed=1, confirmed_timeframes=[10])
    real_5m = _frame(
        [
            _bar(_ts("2026-08-05 10:00"), 100.0),
            _bar(_ts("2026-08-05 10:05"), 150.0),  # deep ITM - premium must clear +20%
            _bar(_ts("2026-08-06 10:00"), 150.0),
            _bar(_ts("2026-08-07 10:00"), 150.0),
        ]
    )
    vix = _vix(["2026-08-05", "2026-08-06", "2026-08-07"])
    trading_days = _trading_days(real_5m)

    trade = simulate_trade(signal, real_5m, vix, trading_days)

    assert trade.exit_reason == "target"
    assert trade.pct_return == pytest.approx(0.20, abs=0.001) or trade.pct_return > 0.20
    assert trade.strike == 100.0


def test_call_hits_stop_on_sharp_drop():
    signal = Signal(time=_ts("2026-08-05 10:00"), direction="call", n_confirmed=1, confirmed_timeframes=[10])
    real_5m = _frame(
        [
            _bar(_ts("2026-08-05 10:00"), 100.0),
            _bar(_ts("2026-08-05 10:05"), 80.0),  # deep OTM - premium must crater
            _bar(_ts("2026-08-06 10:00"), 80.0),
            _bar(_ts("2026-08-07 10:00"), 80.0),
        ]
    )
    vix = _vix(["2026-08-05", "2026-08-06", "2026-08-07"])
    trading_days = _trading_days(real_5m)

    trade = simulate_trade(signal, real_5m, vix, trading_days)

    assert trade.exit_reason == "stop"
    assert trade.pct_return < -0.09


def test_put_direction_profits_from_a_drop():
    signal = Signal(time=_ts("2026-08-05 10:00"), direction="put", n_confirmed=1, confirmed_timeframes=[10])
    real_5m = _frame(
        [
            _bar(_ts("2026-08-05 10:00"), 100.0),
            _bar(_ts("2026-08-05 10:05"), 50.0),  # deep ITM for a put
            _bar(_ts("2026-08-06 10:00"), 50.0),
            _bar(_ts("2026-08-07 10:00"), 50.0),
        ]
    )
    vix = _vix(["2026-08-05", "2026-08-06", "2026-08-07"])
    trading_days = _trading_days(real_5m)

    trade = simulate_trade(signal, real_5m, vix, trading_days)

    assert trade.exit_reason == "target"
    assert trade.pct_return > 0.20
