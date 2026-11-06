from datetime import datetime, timezone

import pandas as pd

from src.range_lab.engine import RangeSpec, _metrics, _run_trade, _split_trades, build_range_lab
from src.range_lab.fetch import _parse_candles


def test_parse_kraken_futures_candles():
    frame = _parse_candles(
        {
            "candles": [
                {
                    "time": 1_700_000_000_000,
                    "open": "100",
                    "high": "110",
                    "low": "90",
                    "close": "105",
                    "volume": "12.5",
                }
            ]
        }
    )
    assert frame.index.tz is not None
    assert frame.iloc[0]["close"] == 105


def test_metrics_compound_and_include_drawdown():
    result = _metrics([
        {"return_pct": 10.0},
        {"return_pct": -5.0},
    ])
    assert result["trades"] == 2
    assert result["win_rate_pct"] == 50.0
    assert result["total_return_pct"] == 4.5
    assert result["max_drawdown_pct"] == 5.0


def test_time_exit_charges_slippage_on_both_sides():
    index = pd.date_range(datetime(2023, 1, 1, tzinfo=timezone.utc), periods=3, freq="4h")
    candles = pd.DataFrame(
        {
            "open": [100.0, 100.0, 100.0],
            "high": [101.0, 101.0, 101.0],
            "low": [99.0, 99.0, 99.0],
            "close": [100.0, 100.0, 100.0],
            "volume": [1.0, 1.0, 1.0],
        },
        index=index,
    )
    trade, _ = _run_trade(
        candles,
        entry_index=1,
        direction="long",
        range_state={"low": 50.0, "high": 250.0, "midpoint": 200.0, "atr": 1.0},
        max_hold_bars=1,
    )
    assert trade["reason"] == "time"
    assert trade["return_pct"] < -0.49


def test_split_embargo_excludes_trade_that_exits_in_next_period():
    start = pd.Timestamp("2025-01-01T00:00:00Z")
    end = pd.Timestamp("2025-02-01T00:00:00Z")
    trades = [
        {
            "entry_time": "2025-01-31T20:00:00+00:00",
            "exit_time": "2025-02-01T04:00:00+00:00",
        },
        {
            "entry_time": "2025-01-10T00:00:00+00:00",
            "exit_time": "2025-01-11T00:00:00+00:00",
        },
    ]
    assert _split_trades(trades, start, end) == [trades[1]]


def test_build_range_lab_preserves_untouched_selection_boundary(monkeypatch):
    index = pd.date_range(datetime(2023, 1, 1, tzinfo=timezone.utc), periods=1_200, freq="4h")
    candles = pd.DataFrame(
        {
            "open": [100.0] * len(index),
            "high": [105.0] * len(index),
            "low": [95.0] * len(index),
            "close": [100.0] * len(index),
            "volume": [1.0] * len(index),
        },
        index=index,
    )
    spec_a = RangeSpec("a", "A", "structure", 20)
    spec_b = RangeSpec("b", "B", "structure", 20)

    def fake_backtest(_candles, spec):
        validation_time = index[750].isoformat()
        holdout_time = index[1_050].isoformat()
        if spec.key == "a":
            return [
                {"entry_time": validation_time, "exit_time": index[751].isoformat(), "return_pct": 2.0},
                {"entry_time": holdout_time, "exit_time": index[1_051].isoformat(), "return_pct": -10.0},
            ]
        return [
            {"entry_time": validation_time, "exit_time": index[751].isoformat(), "return_pct": 1.0},
            {"entry_time": holdout_time, "exit_time": index[1_051].isoformat(), "return_pct": 50.0},
        ]

    monkeypatch.setattr("src.range_lab.engine.backtest_spec", fake_backtest)
    result = build_range_lab(candles, (spec_a, spec_b))
    assert result["validation_leader_key"] == "a"
    assert result["selected_key"] is None
    assert result["holdout_passed"] is False

