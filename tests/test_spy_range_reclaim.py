import pandas as pd
import pytest

from src.spy import range_reclaim_research
from src.spy.range_reclaim import CANDIDATES, _return, generate_trades, historical_holdout_passes, summarize

ET = "America/New_York"


def test_long_and_short_returns_use_entry_capital_as_the_denominator():
    assert _return("long", 100, 110) == pytest.approx(0.10)
    assert _return("long", 100, 90) == pytest.approx(-0.10)
    assert _return("short", 100, 90) == pytest.approx(0.10)
    assert _return("short", 100, 110) == pytest.approx(-0.10)


def _day(date: str, signal_side: str = "long", both_hit: bool = False) -> pd.DataFrame:
    prior = pd.date_range(f"{date} 09:30", periods=78, freq="5min", tz=ET) - pd.Timedelta(days=1)
    current = pd.date_range(f"{date} 09:30", periods=78, freq="5min", tz=ET)
    rows = []
    for timestamp in prior:
        rows.append({"time": timestamp, "open": 100.0, "high": 100.2, "low": 99.8, "close": 100.0, "volume": 100.0})
    for timestamp in current:
        rows.append({"time": timestamp, "open": 100.0, "high": 101.0, "low": 99.0, "close": 100.0, "volume": 100.0})
    frame = pd.DataFrame(rows).set_index("time")
    signal_time = pd.Timestamp(f"{date} 10:00", tz=ET)
    entry_time = pd.Timestamp(f"{date} 10:05", tz=ET)
    if signal_side == "long":
        frame.loc[signal_time, ["open", "high", "low", "close", "volume"]] = [99.2, 99.5, 98.8, 99.1, 130]
        frame.loc[entry_time, ["open", "high", "low", "close"]] = [99.2, 100.1, 98.7 if both_hit else 99.0, 100]
    else:
        frame.loc[signal_time, ["open", "high", "low", "close", "volume"]] = [100.8, 101.2, 100.5, 100.9, 130]
        frame.loc[entry_time, ["open", "high", "low", "close"]] = [100.8, 101.3 if both_hit else 101.0, 99.9, 100]
    return frame.tz_convert("UTC")


def test_long_reclaim_enters_next_bar_and_targets_midpoint():
    trade = generate_trades(_day("2026-08-05"), CANDIDATES[1])[0]
    assert trade.direction == "long"
    assert trade.entry_time == pd.Timestamp("2026-08-05 10:05", tz=ET).tz_convert("UTC")
    assert trade.target == pytest.approx(100)
    assert trade.exit_reason == "target"
    assert trade.net_return_8bps < trade.gross_return


def test_short_reclaim_uses_mirrored_geometry():
    trade = generate_trades(_day("2026-08-05", "short"), CANDIDATES[1])[0]
    assert trade.direction == "short"
    assert trade.target == pytest.approx(100)
    assert trade.exit_reason == "target"


def test_same_bar_stop_and_target_is_counted_as_stop():
    trade = generate_trades(_day("2026-08-05", both_hit=True), CANDIDATES[1])[0]
    assert trade.exit_reason == "stop"
    assert trade.gross_return < 0


def test_volume_threshold_and_one_trade_per_day_are_fail_closed():
    frame = _day("2026-08-05")
    frame.loc[pd.Timestamp("2026-08-05 10:00", tz=ET).tz_convert("UTC"), "volume"] = 110
    assert generate_trades(frame, CANDIDATES[2]) == []


def test_summary_keeps_direction_counts_and_cost_stress_explicit():
    long_trade = generate_trades(_day("2026-08-05"), CANDIDATES[1])[0]
    short_trade = generate_trades(_day("2026-08-06", "short"), CANDIDATES[1])[0]
    result = summarize([long_trade, short_trade])
    assert result["trades"] == 2
    assert result["longs"] == 1
    assert result["shorts"] == 1
    assert result["expectancy_pct"] > 0


def test_small_or_one_sided_sample_cannot_pass_historical_gate():
    long_trade = generate_trades(_day("2026-08-05"), CANDIDATES[1])[0]
    assert historical_holdout_passes([long_trade] * 30) is False


def test_non_selected_candidates_never_process_holdout_timestamps(tmp_path, monkeypatch):
    snapshot = tmp_path / "source.csv.gz"
    snapshot.write_bytes(b"frozen-source")
    monkeypatch.setattr(range_reclaim_research, "SOURCE_SNAPSHOT", snapshot)
    index = pd.DatetimeIndex([
        pd.Timestamp("2026-05-07 15:00", tz=ET),
        pd.Timestamp("2026-06-01 15:00", tz=ET),
    ]).tz_convert("UTC")
    bars = pd.DataFrame({
        "open": [100.0, 101.0],
        "high": [101.0, 102.0],
        "low": [99.0, 100.0],
        "close": [100.5, 101.5],
        "volume": [1000.0, 1000.0],
    }, index=index)
    received = []

    def fake_generator(frame, candidate):
        received.append((candidate.key, frame.index.max()))
        return []

    payload = range_reclaim_research.build_payload(bars, fake_generator)

    assert payload["selected_key"] is None
    assert len(received) == len(CANDIDATES)
    assert all(timestamp.tz_convert(ET) < range_reclaim_research.VALIDATION_END for _, timestamp in received)
