import json

from src import chart_archive


def test_monthly_archive_writes_ordered_chunks_and_manifest(tmp_path, monkeypatch):
    monkeypatch.setattr(chart_archive.config, "DATA_DIR", str(tmp_path))
    rows = [
        {"time": 1761955200, "open": 1, "high": 2, "low": 1, "close": 2},
        {"time": 1764547200, "open": 2, "high": 3, "low": 2, "close": 3},
    ]
    chart_archive.write_monthly_archive("demo", {"15": rows}, "fixture")

    manifest = json.loads((tmp_path / "archive/demo/manifest.json").read_text())
    assert [entry["month"] for entry in manifest["timeframes"]["15"]] == ["2025-11", "2025-12"]
    assert json.loads((tmp_path / "archive/demo/15/2025-11.json").read_text()) == [rows[0]]
    assert manifest["source"] == "fixture"


def test_rolling_refresh_keeps_backfilled_months_and_full_first_session(tmp_path, monkeypatch):
    monkeypatch.setattr(chart_archive.config, "DATA_DIR", str(tmp_path))
    early = {"time": 1730419200, "open": 1, "high": 2, "low": 1, "close": 2}
    boundary = {"time": 1731348000, "open": 2, "high": 3, "low": 2, "close": 3}
    new = {"time": 1733011200, "open": 3, "high": 4, "low": 3, "close": 4}
    chart_archive.write_monthly_archive("demo", {"1": [boundary, new]}, "fixture")
    chart_archive.write_monthly_archive("demo", {"1": [early, {**boundary, "close": 2.5}]}, "fixture")
    chart_archive.write_monthly_archive("demo", {"1": [{**boundary, "close": 2.25}, new]}, "fixture")

    manifest = json.loads((tmp_path / "archive/demo/manifest.json").read_text())
    assert [entry["month"] for entry in manifest["timeframes"]["1"]] == ["2024-11", "2024-12"]
    november = json.loads((tmp_path / "archive/demo/1/2024-11.json").read_text())
    assert november == [early, {**boundary, "close": 2.5}]
    assert manifest["timeframes"]["1"][0]["first"] == early["time"]


def test_monthly_archive_rejects_a_source_change(tmp_path, monkeypatch):
    monkeypatch.setattr(chart_archive.config, "DATA_DIR", str(tmp_path))
    row = {"time": 1730419200, "open": 1, "high": 2, "low": 1, "close": 2}
    chart_archive.write_monthly_archive("demo", {"1": [row]}, "feed A")
    try:
        chart_archive.write_monthly_archive("demo", {"1": [row]}, "feed B")
    except ValueError as error:
        assert "source changed" in str(error)
    else:
        raise AssertionError("source changes must not combine incompatible chart data")


def test_published_equity_archives_keep_the_backfilled_history():
    from pathlib import Path

    data_dir = Path(__file__).resolve().parents[1] / "site" / "data"
    for asset in ("spy", "qqq", "nvda"):
        manifest = json.loads((data_dir / f"archive/{asset}/manifest.json").read_text())
        assert "IEX" in manifest["source"]
        for entries in manifest["timeframes"].values():
            assert entries[0]["month"] <= "2020-07"
            first_chunk = json.loads((data_dir / entries[0]["path"]).read_text())
            assert first_chunk[0]["time"] == entries[0]["first"]
            assert len(first_chunk) == entries[0]["count"]
