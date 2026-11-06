from datetime import datetime, timezone

import pandas as pd
import pytest

from src.range_lab.engine import (
    _gate_positive,
    RangeSpec,
    _metrics,
    _drawdown_duration,
    _paper_trade,
    _run_runner_trade,
    _run_trade,
    _walk_forward_regime,
    backtest_runner_cohort,
    backtest_cost_cohort,
    backtest_spec,
    build_range_lab,
    forward_paper_track,
    forward_qualification_gate,
    robustness_analysis,
    walk_forward_stability,
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


def test_runner_trade_fills_midpoint_and_opposite_edge_for_long():
    index = pd.date_range(datetime(2026, 1, 1, tzinfo=timezone.utc), periods=3, freq="4h")
    candles = pd.DataFrame(
        {
            "open": [95.0, 95.0, 100.0],
            "high": [96.0, 111.0, 101.0],
            "low": [94.0, 94.0, 99.0],
            "close": [95.0, 110.0, 100.0],
            "volume": [1.0, 1.0, 1.0],
        },
        index=index,
    )
    trade, exit_index = _run_runner_trade(
        candles,
        entry_index=1,
        direction="long",
        range_state={"low": 90.0, "high": 110.0, "midpoint": 100.0, "atr": 1.0},
        max_hold_bars=2,
    )
    assert exit_index == 1
    assert trade["reason"] == "runner"
    assert [leg["reason"] for leg in trade["legs"]] == ["midpoint", "runner"]
    assert [leg["size_pct"] for leg in trade["legs"]] == [50.0, 50.0]
    assert trade["return_pct"] > 0
    expected_weighted_return = sum(leg["return_pct"] * 0.5 for leg in trade["legs"])
    assert abs(trade["return_pct"] - expected_weighted_return) < 0.0001


def test_runner_trade_fills_midpoint_and_opposite_edge_for_short():
    index = pd.date_range(datetime(2026, 1, 1, tzinfo=timezone.utc), periods=3, freq="4h")
    candles = pd.DataFrame(
        {
            "open": [105.0, 105.0, 100.0],
            "high": [106.0, 106.0, 101.0],
            "low": [104.0, 89.0, 99.0],
            "close": [105.0, 90.0, 100.0],
            "volume": [1.0, 1.0, 1.0],
        },
        index=index,
    )
    trade, _ = _run_runner_trade(
        candles,
        entry_index=1,
        direction="short",
        range_state={"low": 90.0, "high": 110.0, "midpoint": 100.0, "atr": 1.0},
        max_hold_bars=2,
    )
    assert trade["reason"] == "runner"
    assert [leg["reason"] for leg in trade["legs"]] == ["midpoint", "runner"]
    assert trade["return_pct"] > 0


def test_runner_trade_resolves_same_bar_stop_before_targets():
    index = pd.date_range(datetime(2026, 1, 1, tzinfo=timezone.utc), periods=3, freq="4h")
    candles = pd.DataFrame(
        {
            "open": [95.0, 95.0, 100.0],
            "high": [96.0, 111.0, 101.0],
            "low": [94.0, 89.0, 99.0],
            "close": [95.0, 100.0, 100.0],
            "volume": [1.0, 1.0, 1.0],
        },
        index=index,
    )
    trade, _ = _run_runner_trade(
        candles,
        entry_index=1,
        direction="long",
        range_state={"low": 90.0, "high": 110.0, "midpoint": 100.0, "atr": 1.0},
        max_hold_bars=2,
    )
    assert trade["reason"] == "stop"
    assert len(trade["legs"]) == 1
    assert trade["legs"][0]["reason"] == "stop"
    assert trade["legs"][0]["size_pct"] == 100.0


def test_runner_trade_keeps_original_stop_after_midpoint():
    index = pd.date_range(datetime(2026, 1, 1, tzinfo=timezone.utc), periods=4, freq="4h")
    candles = pd.DataFrame(
        {
            "open": [95.0, 95.0, 99.0, 100.0],
            "high": [96.0, 101.0, 100.0, 101.0],
            "low": [94.0, 94.0, 89.0, 99.0],
            "close": [95.0, 100.0, 90.0, 100.0],
            "volume": [1.0] * 4,
        },
        index=index,
    )
    trade, exit_index = _run_runner_trade(
        candles,
        entry_index=1,
        direction="long",
        range_state={"low": 90.0, "high": 110.0, "midpoint": 100.0, "atr": 1.0},
        max_hold_bars=3,
    )
    assert exit_index == 2
    assert trade["reason"] == "midpoint_then_stop"
    assert [leg["reason"] for leg in trade["legs"]] == ["midpoint", "stop"]
    assert trade["legs"][1]["exit"] < trade["entry"]


def test_runner_comparison_preserves_overlapping_baseline_entry_cohort(monkeypatch):
    index = pd.date_range(datetime(2026, 1, 1, tzinfo=timezone.utc), periods=50, freq="4h")
    candles = pd.DataFrame(
        {
            "open": [100.0] * 50,
            "high": [101.0] * 50,
            "low": [99.0] * 50,
            "close": [100.0] * 50,
            "volume": [1.0] * 50,
        },
        index=index,
    )
    spec = RangeSpec("structure", "Structure", "structure", 20)
    baseline = [
        {
            "direction": "long",
            "signal_time": index[24].isoformat(),
            "entry_time": index[25].isoformat(),
        },
        {
            "direction": "long",
            "signal_time": index[26].isoformat(),
            "entry_time": index[27].isoformat(),
        },
    ]

    monkeypatch.setattr(
        "src.range_lab.engine._range_at",
        lambda *_args: {"low": 90.0, "high": 150.0, "midpoint": 120.0, "edge": 6.0, "atr": 1.0},
    )
    monkeypatch.setattr("src.range_lab.engine._signal", lambda *_args: "long")
    runner = backtest_runner_cohort(candles, spec, baseline)
    assert len(runner) == 2
    assert [trade["entry_time"] for trade in runner] == [
        trade["entry_time"] for trade in baseline
    ]
    assert runner[0]["exit_time"] > runner[1]["entry_time"]


def test_cost_stress_preserves_trade_path_and_only_worsens_return(monkeypatch):
    index = pd.date_range(datetime(2026, 1, 1, tzinfo=timezone.utc), periods=50, freq="4h")
    candles = pd.DataFrame(
        {
            "open": [100.0] * 50,
            "high": [101.0] * 50,
            "low": [99.0] * 50,
            "close": [100.0] * 50,
            "volume": [1.0] * 50,
        },
        index=index,
    )
    spec = RangeSpec("structure", "Structure", "structure", 20)
    state = {"low": 90.0, "high": 150.0, "midpoint": 120.0, "edge": 6.0, "atr": 1.0}
    baseline, _ = _run_trade(candles, 25, "long", state, spec.lookback_bars)

    monkeypatch.setattr("src.range_lab.engine._range_at", lambda *_args: state)
    monkeypatch.setattr("src.range_lab.engine._signal", lambda *_args: "long")
    stressed = backtest_cost_cohort(candles, spec, [baseline], 0.0040, 0.0015)
    identity = ("signal_time", "entry_time", "exit_time", "direction", "reason")
    assert tuple(stressed[0][field] for field in identity) == tuple(
        baseline[field] for field in identity
    )
    assert stressed[0]["return_pct"] < baseline["return_pct"]


def test_drawdown_duration_counts_underwater_trades_through_recovery():
    trades = [
        {
            "entry_time": "2026-01-01T00:00:00+00:00",
            "exit_time": "2026-01-01T12:00:00+00:00",
            "return_pct": 10.0,
        },
        {
            "entry_time": "2026-01-02T00:00:00+00:00",
            "exit_time": "2026-01-02T12:00:00+00:00",
            "return_pct": -5.0,
        },
        {
            "entry_time": "2026-01-03T00:00:00+00:00",
            "exit_time": "2026-01-03T12:00:00+00:00",
            "return_pct": -5.0,
        },
        {
            "entry_time": "2026-01-04T00:00:00+00:00",
            "exit_time": "2026-01-04T12:00:00+00:00",
            "return_pct": 25.0,
        },
    ]
    duration = _drawdown_duration(trades)
    assert duration["max_underwater_trades"] == 2
    assert duration["max_underwater_days"] == 3.0
    assert duration["recovered"] is True


def test_robustness_requires_sixty_total_and_thirty_per_direction(monkeypatch):
    candles = pd.DataFrame(
        {"close": [100.0, 101.0]},
        index=pd.date_range(datetime(2026, 1, 1, tzinfo=timezone.utc), periods=2, freq="4h"),
    )
    spec = RangeSpec("structure", "Structure", "structure", 20)
    trades = []
    for offset in range(60):
        timestamp = pd.Timestamp("2025-01-01T00:00:00Z") + pd.Timedelta(days=offset)
        trades.append({
            "signal_time": (timestamp - pd.Timedelta(hours=4)).isoformat(),
            "entry_time": timestamp.isoformat(),
            "exit_time": (timestamp + pd.Timedelta(hours=4)).isoformat(),
            "direction": "long" if offset < 30 else "short",
            "reason": "target",
            "return_pct": 1.0,
        })
    walk_forward = {"stable": True, "aggregate": _metrics(trades)}
    monkeypatch.setattr(
        "src.range_lab.engine._walk_forward_baseline_trades",
        lambda *_args: trades,
    )
    monkeypatch.setattr(
        "src.range_lab.engine.backtest_cost_cohort",
        lambda _candles, _spec, baseline, _fee, _slippage: baseline,
    )
    result = robustness_analysis(candles, spec, walk_forward)
    assert result["sample_adequate"] is True
    assert result["direction_balanced"] is True
    assert result["cost_resilient"] is True
    assert result["robust"] is True

    short_trade = trades.pop()
    walk_forward = {"stable": True, "aggregate": _metrics(trades)}
    result = robustness_analysis(candles, spec, walk_forward)
    assert result["sample_adequate"] is False
    assert result["directions"]["short"]["sample_adequate"] is False
    assert result["robust"] is False
    trades.append(short_trade)


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


def test_forward_gate_waits_for_fifty_closed_trades(monkeypatch):
    candles = pd.DataFrame(
        {"close": [100.0, 101.0]},
        index=pd.date_range(datetime(2026, 1, 1, tzinfo=timezone.utc), periods=2, freq="4h"),
    )
    spec = RangeSpec("structure", "Structure", "structure", 20)
    paper = {
        "metrics": _metrics([]),
        "closed_trades": [],
        "open_trade": {"status": "open", "direction": "long"},
        "pending_entry": None,
    }
    monkeypatch.setattr(
        "src.range_lab.engine.backtest_cost_cohort",
        lambda _candles, _spec, baseline, _fee, _slippage: baseline,
    )
    result = forward_qualification_gate(candles, spec, paper)
    assert result["qualified"] is False
    assert result["status"] == "WAIT — NOT ENOUGH EVIDENCE (0/50 CLOSED)"
    assert result["progress_pct"] == 0.0
    assert result["checks"]["sample"]["closed_trades"] == 0


def test_forward_gate_profit_factor_threshold_is_inclusive():
    metrics = {"expectancy_pct": 0.01, "profit_factor": 1.2, "profit_factor_infinite": False}
    assert _gate_positive(metrics, 1.2) is True
    metrics["profit_factor"] = 1.199
    assert _gate_positive(metrics, 1.2) is False


def test_forward_gate_exact_thresholds_and_later_half_extra_trade(monkeypatch):
    candles = pd.DataFrame(
        {"close": [100.0, 101.0]},
        index=pd.date_range(datetime(2026, 1, 1, tzinfo=timezone.utc), periods=2, freq="4h"),
    )
    spec = RangeSpec("structure", "Structure", "structure", 20)
    trades = []
    for offset in range(50):
        entry = pd.Timestamp("2026-11-07T00:00:00Z") + pd.Timedelta(days=offset)
        trades.append({
            "status": "closed",
            "signal_time": (entry - pd.Timedelta(hours=4)).isoformat(),
            "entry_time": entry.isoformat(),
            "exit_time": (entry + pd.Timedelta(hours=4)).isoformat(),
            "direction": "long" if offset < 25 else "short",
            "reason": "target",
            "return_pct": 1.0,
        })

    monkeypatch.setattr(
        "src.range_lab.engine.backtest_cost_cohort",
        lambda _candles, _spec, baseline, _fee, _slippage: baseline,
    )
    paper = {
        "metrics": _metrics(trades),
        "closed_trades": trades,
        "open_trade": None,
        "pending_entry": None,
    }
    result = forward_qualification_gate(candles, spec, paper)
    assert result["qualified"] is True
    assert result["passed_checks"] == result["total_checks"] == 6
    assert result["progress_pct"] == 100.0
    assert result["checks"]["halves"]["earlier"]["trades"] == 25
    assert result["checks"]["halves"]["later"]["trades"] == 25
    assert result["checks"]["directions"]["long"]["trades"] == 25
    assert result["checks"]["directions"]["short"]["trades"] == 25

    extra = dict(trades[-1])
    extra["signal_time"] = "2027-01-15T20:00:00+00:00"
    extra["entry_time"] = "2027-01-16T00:00:00+00:00"
    extra["exit_time"] = "2027-01-16T04:00:00+00:00"
    trades.append(extra)
    paper["metrics"] = _metrics(trades)
    result = forward_qualification_gate(candles, spec, paper)
    assert result["checks"]["halves"]["earlier"]["trades"] == 25
    assert result["checks"]["halves"]["later"]["trades"] == 26


def test_forward_gate_is_revoked_when_later_full_sample_fails(monkeypatch):
    candles = pd.DataFrame(
        {"close": [100.0, 101.0]},
        index=pd.date_range(datetime(2026, 1, 1, tzinfo=timezone.utc), periods=2, freq="4h"),
    )
    spec = RangeSpec("structure", "Structure", "structure", 20)
    trades = []
    for offset in range(50):
        entry = pd.Timestamp("2026-11-07T00:00:00Z") + pd.Timedelta(days=offset)
        trades.append({
            "status": "closed",
            "signal_time": (entry - pd.Timedelta(hours=4)).isoformat(),
            "entry_time": entry.isoformat(),
            "exit_time": (entry + pd.Timedelta(hours=4)).isoformat(),
            "direction": "long" if offset < 25 else "short",
            "reason": "target",
            "return_pct": 1.0,
        })
    trades[-1]["return_pct"] = -50.0
    monkeypatch.setattr(
        "src.range_lab.engine.backtest_cost_cohort",
        lambda _candles, _spec, baseline, _fee, _slippage: baseline,
    )
    paper = {
        "metrics": _metrics(trades),
        "closed_trades": trades,
        "open_trade": None,
        "pending_entry": None,
    }
    result = forward_qualification_gate(candles, spec, paper)
    assert result["qualified"] is False
    assert result["status"] == "NOT FORWARD-QUALIFIED"
    assert result["checks"]["sample"]["passed"] is True
    assert result["checks"]["halves"]["passed"] is False


def test_forward_gate_rejects_a_stressed_cohort_identity_change(monkeypatch):
    candles = pd.DataFrame(
        {"close": [100.0, 101.0]},
        index=pd.date_range(datetime(2026, 1, 1, tzinfo=timezone.utc), periods=2, freq="4h"),
    )
    spec = RangeSpec("structure", "Structure", "structure", 20)
    trade = {
        "status": "closed",
        "signal_time": "2026-11-06T20:00:00+00:00",
        "entry_time": "2026-11-07T00:00:00+00:00",
        "exit_time": "2026-11-07T04:00:00+00:00",
        "direction": "long",
        "reason": "target",
        "return_pct": 1.0,
    }
    paper = {"metrics": _metrics([trade]), "closed_trades": [trade]}
    changed = dict(trade, reason="stop")
    monkeypatch.setattr(
        "src.range_lab.engine.backtest_cost_cohort",
        lambda _candles, _spec, _baseline, _fee, _slippage: [changed],
    )
    with pytest.raises(RuntimeError, match="changed the closed paper cohort"):
        forward_qualification_gate(candles, spec, paper)


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


def test_walk_forward_uses_continuous_entries_and_frozen_sample_gate(monkeypatch):
    index = pd.date_range(
        datetime(2022, 12, 1, tzinfo=timezone.utc),
        datetime(2026, 8, 1, tzinfo=timezone.utc),
        freq="4h",
    )
    candles = pd.DataFrame(
        {"open": 100.0, "high": 101.0, "low": 99.0, "close": 100.0, "volume": 1.0},
        index=index,
    )
    spec = RangeSpec("structure", "Structure", "structure", 20)
    starts = pd.date_range("2023-01-01T00:00:00Z", periods=7, freq="6MS")
    fake_trades = []
    for window_index, start in enumerate(starts):
        count = 10 if window_index < 4 else 9
        for offset in range(count):
            entry = start + pd.Timedelta(days=offset + 1)
            exit_time = entry + pd.Timedelta(hours=4)
            fake_trades.append({
                "entry_time": entry.isoformat(),
                "exit_time": exit_time.isoformat(),
                "return_pct": 1.0,
            })
    # The reporting bucket is set by entry, even if the position exits after
    # the next window begins.
    fake_trades[9]["entry_time"] = "2023-06-30T20:00:00+00:00"
    fake_trades[9]["exit_time"] = "2023-07-02T00:00:00+00:00"

    calls = []

    def fake_backtest(_candles, _spec, start=None, end=None):
        calls.append((start, end))
        return fake_trades

    monkeypatch.setattr("src.range_lab.engine.backtest_spec", fake_backtest)
    result = walk_forward_stability(candles, spec)
    assert calls == [(pd.Timestamp("2023-01-01T00:00:00Z"), None)]
    assert result["eligible_windows"] == 4
    assert result["positive_windows"] == 4
    assert result["positive_share_pct"] == 100.0
    assert result["stable"] is True
    assert result["windows"][0]["metrics"]["trades"] == 10
    assert result["windows"][0]["regime"] == "sideways"
    assert result["windows"][4]["sample_eligible"] is False


def test_walk_forward_regime_uses_frozen_fifteen_percent_thresholds():
    index = pd.date_range(datetime(2025, 1, 1, tzinfo=timezone.utc), periods=2, freq="4h")

    def regime(final_close):
        candles = pd.DataFrame({"close": [100.0, final_close]}, index=index)
        return _walk_forward_regime(candles, index[0], index[-1] + pd.Timedelta(hours=4))[0]

    assert regime(116.0) == "bull"
    assert regime(84.0) == "bear"
    assert regime(115.0) == "sideways"
    assert regime(85.0) == "sideways"


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
    monkeypatch.setattr(
        "src.range_lab.engine.backtest_runner_cohort",
        lambda _candles, _spec, baseline, end=None: baseline,
    )
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
    monkeypatch.setattr(
        "src.range_lab.engine.backtest_runner_cohort",
        lambda _candles, _spec, baseline, end=None: baseline,
    )
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
    monkeypatch.setattr(
        "src.range_lab.engine.backtest_runner_cohort",
        lambda _candles, _spec, baseline, end=None: baseline,
    )
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
