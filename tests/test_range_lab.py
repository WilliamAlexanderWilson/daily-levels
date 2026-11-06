from datetime import datetime, timezone

import pandas as pd

from src.range_lab.engine import RangeSpec, _metrics, _run_trade, backtest_spec, build_range_lab
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


def test_metrics_represents_zero_loss_profit_factor_without_invalid_json_number():
    result = _metrics([{"return_pct": 1.0}, {"return_pct": 2.0}])
    assert result["profit_factor"] is None
    assert result["profit_factor_infinite"] is True


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


def test_partition_replay_caps_positions_at_boundary(monkeypatch):
    index = pd.date_range(datetime(2023, 1, 1, tzinfo=timezone.utc), periods=200, freq="4h")
    candles = pd.DataFrame(
        {"open": 100.0, "high": 101.0, "low": 99.0, "close": 100.0, "volume": 1.0},
        index=index,
    )
    spec = RangeSpec("structure", "Structure", "structure", 20)
    boundary = index[100]
    calls = []

    def fake_range(_candles, cursor, _spec, _atr):
        return {"low": 90.0, "high": 110.0, "midpoint": 100.0, "edge": 2.0, "atr": 1.0}

    def fake_signal(_candle, _state):
        calls.append(True)
        return None

    monkeypatch.setattr("src.range_lab.engine._range_at", fake_range)
    monkeypatch.setattr("src.range_lab.engine._signal", fake_signal)
    backtest_spec(candles, spec, start=boundary, end=index[110])
    assert len(calls) == 9


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

    def fake_backtest(_candles, spec, start=None, end=None):
        validation_time = index[750].isoformat()
        holdout_time = index[1_050].isoformat()
        if spec.key == "a":
            trades = [
                {"entry_time": validation_time, "exit_time": index[751].isoformat(), "return_pct": 2.0},
                {"entry_time": holdout_time, "exit_time": index[1_051].isoformat(), "return_pct": -10.0},
            ]
        else:
            trades = [
                {"entry_time": validation_time, "exit_time": index[751].isoformat(), "return_pct": 1.0},
                {"entry_time": holdout_time, "exit_time": index[1_051].isoformat(), "return_pct": 50.0},
            ]
        return [
            trade for trade in trades
            if (start is None or pd.Timestamp(trade["entry_time"]) >= start)
            and (end is None or pd.Timestamp(trade["exit_time"]) < end)
        ]

    monkeypatch.setattr("src.range_lab.engine.backtest_spec", fake_backtest)
    result = build_range_lab(
        candles,
        (spec_a, spec_b),
        train_end=index[600],
        validation_end=index[900],
        holdout_end=index[-1] + pd.Timedelta(hours=4),
    )
    assert result["validation_leader_key"] == "a"
    assert result["selected_key"] is None
    assert result["holdout_passed"] is False


def test_zero_loss_profit_factor_can_pass_only_with_required_sample_sizes(monkeypatch):
    index = pd.date_range(datetime(2023, 1, 1, tzinfo=timezone.utc), periods=1_200, freq="4h")
    candles = pd.DataFrame(
        {"open": 100.0, "high": 105.0, "low": 95.0, "close": 100.0, "volume": 1.0},
        index=index,
    )
    spec = RangeSpec("only", "Only", "structure", 20)
    train_end = index[600]
    validation_end = index[900]
    holdout_end = index[-1] + pd.Timedelta(hours=4)

    def fake_backtest(_candles, _spec, start=None, end=None):
        count = 20 if start == train_end else 30 if start == validation_end else 1
        return [
            {
                "entry_time": (start + pd.Timedelta(hours=4 * offset)).isoformat(),
                "exit_time": (start + pd.Timedelta(hours=4 * offset + 1)).isoformat(),
                "return_pct": 1.0,
            }
            for offset in range(count)
        ]

    monkeypatch.setattr("src.range_lab.engine.backtest_spec", fake_backtest)
    result = build_range_lab(
        candles,
        (spec,),
        train_end=train_end,
        validation_end=validation_end,
        holdout_end=holdout_end,
    )
    assert result["selected_key"] == "only"
    assert result["holdout_passed"] is True

