"""load_previous_snapshot: finds the latest history file strictly before
a given date, regardless of gaps (a missed run shouldn't break the diff)."""

import json

import src.output as output_module
from src.output import load_previous_snapshot


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
