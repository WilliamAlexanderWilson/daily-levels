"""Runs the full engine against a saved real Kraken response (no network
call), checking the pipeline holds together end to end rather than any
specific hand-computed number."""

import json
import os

import pytest

from src.fetch import _parse_response
from src.levels.engine import build_asset_levels

FIXTURES_DIR = os.path.join(os.path.dirname(__file__), "fixtures")


def _load_fixture_candles(filename: str, symbol: str):
    with open(os.path.join(FIXTURES_DIR, filename)) as f:
        payload = json.load(f)
    return _parse_response(payload, symbol)


@pytest.fixture
def patched_fetch(monkeypatch):
    candles_4h = _load_fixture_candles("btc_4h_real.json", "BTC/USD")
    candles_1d = _load_fixture_candles("btc_1d_real.json", "BTC/USD")

    def fake_fetch_candles(symbol: str, interval: int):
        assert symbol == "BTC/USD"
        return candles_4h if interval == 240 else candles_1d

    monkeypatch.setattr("src.levels.engine.fetch_candles", fake_fetch_candles)
    return candles_4h, candles_1d


def test_engine_runs_end_to_end_on_real_fixture(patched_fetch):
    candles_4h, candles_1d = patched_fetch

    output = build_asset_levels("BTC/USD")
    result = output["result"]

    assert result["price"] == pytest.approx(float(candles_4h["close"].iloc[-1]))
    assert len(result["levels"]) > 0

    required_keys = {"name", "price_low", "price_high", "type", "distance_pct", "strength", "is_flip"}
    for level in result["levels"]:
        assert required_keys.issubset(level.keys())
        assert level["type"] in ("support", "resistance")
        assert level["price_low"] <= level["price_high"]
        assert level["strength"] >= 1

    # levels must be sorted by price
    mids = [(lvl["price_low"] + lvl["price_high"]) / 2 for lvl in result["levels"]]
    assert mids == sorted(mids)

    assert result["config"]["range_days"] == 60
    assert "generated_at_utc" in result
    assert "generated_at_central" in result

    assert "liquidation_estimate" in result
    assert len(result["liquidation_estimate"]) > 0
    for b in result["liquidation_estimate"]:
        assert b["price_low"] < b["price_high"]
        assert 0.0 <= b["long_intensity"] <= 1.0
        assert 0.0 <= b["short_intensity"] <= 1.0
        assert b["long_intensity"] > 0 or b["short_intensity"] > 0
    assert result["config"]["liquidation_leverage_tiers"] == [10, 25, 50, 100]

    assert len(output["candles_4h"]) == len(candles_4h)
    assert len(output["candles_1d"]) == len(candles_1d)
