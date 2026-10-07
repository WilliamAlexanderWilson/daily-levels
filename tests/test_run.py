"""The daily-run gate: "has this asset already produced today's data,"
not "is it exactly the target hour right now" - see src/run.py's
docstring for why (GitHub's cron fires hours late in practice)."""

import json

import config
from src.run import _already_ran_today


def test_no_file_yet_has_not_run(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", str(tmp_path))
    assert _already_ran_today("btc", "2026-10-06") is False


def test_file_from_today_has_run(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", str(tmp_path))
    with open(tmp_path / "btc_levels.json", "w") as f:
        json.dump({"generated_at_central": "2026-10-06T05:03:11-05:00"}, f)

    assert _already_ran_today("btc", "2026-10-06") is True


def test_file_from_yesterday_has_not_run_today(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", str(tmp_path))
    with open(tmp_path / "btc_levels.json", "w") as f:
        json.dump({"generated_at_central": "2026-10-05T05:04:02-05:00"}, f)

    assert _already_ran_today("btc", "2026-10-06") is False


def test_each_asset_checked_independently(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", str(tmp_path))
    with open(tmp_path / "btc_levels.json", "w") as f:
        json.dump({"generated_at_central": "2026-10-06T05:03:11-05:00"}, f)
    # no eth_levels.json written at all

    assert _already_ran_today("btc", "2026-10-06") is True
    assert _already_ran_today("eth", "2026-10-06") is False
