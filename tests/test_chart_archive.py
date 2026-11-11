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
