from datetime import datetime, timezone

import pandas as pd

from src.range_lab.engine import (
    RangeSpec,
    _metrics,
    _paper_trade,
    _run_trade,
    backtest_spec,
    build_range_lab,
    forward_paper_track,
)
from src.range_lab.fetch import _parse_candles, _validate_history
from src.range_lab.reconciliation import reconcile_spot_futures


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


def test_history_validation_rejects_missing_four_hour_candle():
    start = datetime(2023, 1, 1, tzinfo=timezone.utc)
    end = datetime(2023, 1, 2, tzinfo=timezone.utc)
    index = pd.date_range(start, end - pd.Timedelta(hours=4), freq="4h").delete(2)
    candles = pd.DataFrame({"close": 100.0}, index=index)
    try:
        _validate_history(candles, start, end)
    except RuntimeError as error:
        assert "1 missing" in str(error)
    else:
        raise AssertionError("gapped history must be rejected")


def test_spot_futures_reconciliation_reports_coverage_and_basis():
    index = pd.date_range(datetime(2026, 11, 1, tzinfo=timezone.utc), periods=4, freq="4h")
    spot = pd.DataFrame(
        {
            "open": [100.0, 101.0, 102.0, 103.0],
            "high": [102.0, 103.0, 104.0, 105.0],
            "low": [99.0, 100.0, 101.0, 102.0],
            "close": [101.0, 102.0, 103.0, 104.0],
        },
        index=index,
    )
    futures = spot * 1.01
    result = reconcile_spot_futures(futures, spot)
    assert result["overlap_candles"] == 4
    assert result["missing_in_spot"] == 0
    assert result["missing_in_futures"] == 0
    assert result["field_basis"]["close"]["median_signed_pct"] == 1.0
    assert result["field_basis"]["close"]["p95_abs_pct"] == 1.0
    assert result["candle_direction_agreement_pct"] == 100.0
    assert result["high_low_envelope_overlap_pct"] == 100.0


def test_spot_futures_reconciliation_reports_missing_inner_timestamp():
    index = pd.date_range(datetime(2026, 11, 1, tzinfo=timezone.utc), periods=4, freq="4h")
    values = {
        "open": [100.0] * 4,
        "high": [101.0] * 4,
        "low": [99.0] * 4,
        "close": [100.0] * 4,
    }
    futures = pd.DataFrame(values, index=index)
    spot = futures.drop(index[1])
    result = reconcile_spot_futures(futures, spot)
    assert result["overlap_candles"] == 3
    assert result["missing_in_spot"] == 1
    assert result["missing_spot_timestamps"] == [index[1].isoformat()]


def test_spot_futures_reconciliation_does_not_hide_missing_endpoint():
    index = pd.date_range(datetime(2026, 11, 1, tzinfo=timezone.utc), periods=4, freq="4h")
    values = {
        "open": [100.0] * 4,
        "high": [101.0] * 4,
        "low": [99.0] * 4,
        "close": [100.0] * 4,
    }
    spot = pd.DataFrame(values, index=index)
    futures = spot.drop(index[0])
    result = reconcile_spot_futures(futures, spot)
    assert result["comparison_start"] == index[0].isoformat()
    assert result["aligned_start"] == index[1].isoformat()
    assert result["missing_in_futures"] == 1
    assert result["missing_futures_timestamps"] == [index[0].isoformat()]


def test_spot_futures_reconciliation_rejects_non_overlapping_history():
    futures_index = pd.date_range(datetime(2026, 11, 1, tzinfo=timezone.utc), periods=2, freq="4h")
    spot_index = pd.date_range(datetime(2026, 11, 2, tzinfo=timezone.utc), periods=2, freq="4h")
    values = {"open": 100.0, "high": 101.0, "low": 99.0, "close": 100.0}
    futures = pd.DataFrame(values, index=futures_index)
    spot = pd.DataFrame(values, index=spot_index)
    try:
        reconcile_spot_futures(futures, spot)
    except ValueError as error:
        assert "no overlapping time window" in str(error)
    else:
        raise AssertionError("non-overlapping markets must not produce reconciliation metrics")


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
    assert trade["exit_time"] == index[1].isoformat()
    assert trade["return_pct"] < -0.49


def test_trade_fees_scale_exit_fee_with_exit_notional():
    from src.range_lab.engine import FEE_PER_SIDE, _trade_return

    result = _trade_return("long", 100.0, 110.0)
    expected = 0.10 - FEE_PER_SIDE - (FEE_PER_SIDE * 1.10)
    assert result == expected


def test_forward_paper_trade_stays_open_until_full_holding_window():
    index = pd.date_range(datetime(2026, 11, 6, tzinfo=timezone.utc), periods=3, freq="4h")
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
    trade, _, resolved = _paper_trade(
        candles,
        entry_index=1,
        direction="long",
        range_state={"low": 90.0, "high": 130.0, "midpoint": 120.0, "atr": 1.0},
        max_hold_bars=3,
    )
    assert resolved is False
    assert trade["status"] == "open"
    assert trade["bars_observed"] == 2
    assert "exit_time" not in trade
    assert "return_pct" not in trade


def test_forward_paper_trade_closes_at_time_only_after_full_window():
    index = pd.date_range(datetime(2026, 11, 6, tzinfo=timezone.utc), periods=4, freq="4h")
    candles = pd.DataFrame(
        {
            "open": [100.0] * 4,
            "high": [101.0] * 4,
            "low": [99.0] * 4,
            "close": [100.0] * 4,
            "volume": [1.0] * 4,
        },
        index=index,
    )
    trade, exit_index, resolved = _paper_trade(
        candles,
        entry_index=1,
        direction="long",
        range_state={"low": 90.0, "high": 130.0, "midpoint": 120.0, "atr": 1.0},
        max_hold_bars=3,
    )
    assert resolved is True
    assert exit_index == 3
    assert trade["status"] == "closed"
    assert trade["reason"] == "time"
    assert trade["exit_time"] == index[3].isoformat()


def test_forward_paper_track_records_pending_entry_without_inventing_fill(monkeypatch):
    index = pd.date_range(datetime(2026, 11, 1, tzinfo=timezone.utc), periods=30, freq="4h")
    candles = pd.DataFrame(
        {"open": 100.0, "high": 101.0, "low": 99.0, "close": 100.0, "volume": 1.0},
        index=index,
    )
    spec = RangeSpec("structure", "Structure", "structure", 20)

    def fake_range(_candles, _cursor, _spec, _atr):
        return {"low": 90.0, "high": 110.0, "midpoint": 100.0, "edge": 2.0, "atr": 1.0}

    def fake_signal(_candle, _state):
        return "long"

    monkeypatch.setattr("src.range_lab.engine._range_at", fake_range)
    monkeypatch.setattr("src.range_lab.engine._signal", fake_signal)
    result = forward_paper_track(candles, spec, start=index[-1])
    assert result["metrics"]["trades"] == 0
    assert result["open_trade"] is None
    assert result["pending_entry"]["status"] == "pending_entry"
    assert "entry" not in result["pending_entry"]


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


def test_sparse_lucky_candidate_cannot_crowd_out_eligible_validation_candidate(monkeypatch):
    index = pd.date_range(datetime(2023, 1, 1, tzinfo=timezone.utc), periods=1_200, freq="4h")
    candles = pd.DataFrame(
        {"open": 100.0, "high": 105.0, "low": 95.0, "close": 100.0, "volume": 1.0},
        index=index,
    )
    sparse = RangeSpec("sparse", "Sparse", "structure", 20)
    eligible = RangeSpec("eligible", "Eligible", "structure", 20)
    train_end = index[600]
    validation_end = index[900]
    holdout_end = index[-1] + pd.Timedelta(hours=4)

    def fake_backtest(_candles, spec, start=None, end=None):
        if start == train_end:
            count, return_pct = (1, 10.0) if spec.key == "sparse" else (20, 1.0)
        elif start == validation_end:
            count, return_pct = 30, 1.0
        else:
            count, return_pct = 1, 1.0
        return [
            {
                "entry_time": (start + pd.Timedelta(hours=4 * offset)).isoformat(),
                "exit_time": (start + pd.Timedelta(hours=4 * offset + 1)).isoformat(),
                "return_pct": return_pct,
            }
            for offset in range(count)
        ]

    monkeypatch.setattr("src.range_lab.engine.backtest_spec", fake_backtest)
    result = build_range_lab(
        candles,
        (sparse, eligible),
        train_end=train_end,
        validation_end=validation_end,
        holdout_end=holdout_end,
    )
    assert result["validation_leader_key"] == "sparse"
    assert result["selected_key"] == "eligible"
    assert result["holdout_passed"] is True
