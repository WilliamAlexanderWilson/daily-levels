"""load_previous_snapshot: finds the latest history file strictly before
a given date, regardless of gaps (a missed run shouldn't break the diff)."""

import json

import pandas as pd

import src.output as output_module
from src.output import load_current_snapshot, load_previous_snapshot, write_asset_outputs


def test_finds_latest_prior_date_skipping_gaps(tmp_path, monkeypatch):
    asset_dir = tmp_path / "btc"
    asset_dir.mkdir()
    (asset_dir / "2026-10-01.json").write_text(json.dumps({"marker": "oct1"}))
    (asset_dir / "2026-10-03.json").write_text(json.dumps({"marker": "oct3"}))  # oct2 missing
    monkeypatch.setattr(output_module, "HISTORY_DIR", str(tmp_path))

    result = load_previous_snapshot("btc", "2026-10-05")
    assert result["marker"] == "oct3"


def test_ignores_same_date_and_future_dates(tmp_path, monkeypatch):
    asset_dir = tmp_path / "btc"
    asset_dir.mkdir()
    (asset_dir / "2026-10-05.json").write_text(json.dumps({"marker": "today"}))
    (asset_dir / "2026-10-06.json").write_text(json.dumps({"marker": "future"}))
    monkeypatch.setattr(output_module, "HISTORY_DIR", str(tmp_path))

    assert load_previous_snapshot("btc", "2026-10-05") is None


def test_missing_history_dir_returns_none(tmp_path, monkeypatch):
    monkeypatch.setattr(output_module, "HISTORY_DIR", str(tmp_path))
    assert load_previous_snapshot("eth", "2026-10-05") is None


def test_load_current_snapshot_includes_same_day_output(tmp_path, monkeypatch):
    monkeypatch.setattr(output_module, "DATA_DIR", str(tmp_path))
    (tmp_path / "btc_levels.json").write_text(json.dumps({"marker": "same-day"}))
    assert load_current_snapshot("btc")["marker"] == "same-day"
    assert load_current_snapshot("eth") is None


def test_btc_output_publishes_the_structural_audit(tmp_path, monkeypatch):
    data_dir = tmp_path / "data"
    history_dir = data_dir / "history"
    monkeypatch.setattr(output_module, "DATA_DIR", str(data_dir))
    monkeypatch.setattr(output_module, "HISTORY_DIR", str(history_dir))
    empty_candles = pd.DataFrame()
    result = {
        "generated_at_utc": "2026-11-08T07:00:00Z",
        "generated_at_central": "2026-11-08T01:00:00-06:00",
        "levels": [],
        "structural_reclaim": {
            "quality": "established",
            "calculated_at_utc": "2026-11-08T07:00:00Z",
            "boundary": {
                "exact_price": 82_790.9,
                "origin_date": "2026-05-06",
                "pivot_count": 4,
                "distinct_months": 4,
                "span_days": 176,
            },
        },
    }

    write_asset_outputs(
        "btc",
        {"result": result, "candles_4h": empty_candles, "candles_1d": empty_candles},
    )

    published = json.loads((data_dir / "btc_levels.json").read_text())
    history = json.loads((history_dir / "btc" / "2026-11-08.json").read_text())
    assert published["structural_reclaim_audit"]["status"] == "initialized"
    assert history["structural_reclaim_audit"] == published["structural_reclaim_audit"]

    result["generated_at_utc"] = "2026-11-08T08:00:00Z"
    write_asset_outputs(
        "btc",
        {"result": result, "candles_4h": empty_candles, "candles_1d": empty_candles},
    )
    rerun = json.loads((data_dir / "btc_levels.json").read_text())
    assert rerun["structural_reclaim_audit"]["status"] == "unchanged"
    assert rerun["structural_reclaim_audit"]["current_since"] == "2026-11-08T07:00:00Z"
    assert rerun["structural_reclaim_audit"]["notification"]["should_notify"] is False
