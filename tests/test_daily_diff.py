"""Hand-verifiable daily diff: new / moved / unchanged / removed, per
level kind, reconstructed from merged-zone midpoints."""

import pytest

from src.levels.daily_diff import compute_diff, extract_kind_prices


def _level(name, low, high=None, **kw):
    high = low if high is None else high
    return {"name": name, "price_low": low, "price_high": high, "type": "support", "strength": 1, "is_flip": False, **kw}


def test_extract_kind_prices_splits_merged_names():
    levels = [_level("POC (60d)", 100.0), _level("VAH (60d) + Prior month low", 150.0, 150.2)]
    prices = extract_kind_prices(levels)
    assert prices["POC (60d)"] == pytest.approx(100.0)
    assert prices["VAH (60d)"] == pytest.approx(150.1)
    assert prices["Prior month low"] == pytest.approx(150.1)


def test_no_previous_snapshot_everything_is_new():
    today = [_level("POC (60d)", 100.0), _level("VAH (60d)", 150.0)]
    diff = compute_diff(today, None)
    assert {d["kind"] for d in diff} == {"POC (60d)", "VAH (60d)"}
    assert all(d["status"] == "new" and d["old_price"] is None for d in diff)


def test_new_moved_unchanged_removed():
    today = [
        _level("POC (60d)", 102.0),  # was 100.0 -> +2% -> moved
        _level("VAH (60d) + Prior month low", 150.0),  # VAH was 150.05 (~-0.033%, unchanged); Prior month low is new
        _level("Golden pocket", 200.0, 200.1),  # brand new kind
    ]
    previous = [
        _level("POC (60d)", 100.0),
        _level("VAH (60d)", 150.05),
        _level("Flip support", 90.0),  # gone today -> removed
    ]

    diff = {d["kind"]: d for d in compute_diff(today, previous)}

    assert diff["POC (60d)"]["status"] == "moved"
    assert diff["POC (60d)"]["old_price"] == pytest.approx(100.0)
    assert diff["POC (60d)"]["new_price"] == pytest.approx(102.0)
    assert diff["POC (60d)"]["change_pct"] == pytest.approx(2.0)

    assert diff["VAH (60d)"]["status"] == "unchanged"
    assert diff["VAH (60d)"]["change_pct"] == pytest.approx(-0.0333, abs=1e-3)

    assert diff["Prior month low"]["status"] == "new"
    assert diff["Prior month low"]["old_price"] is None
    assert diff["Prior month low"]["new_price"] == pytest.approx(150.0)

    assert diff["Golden pocket"]["status"] == "new"
    assert diff["Golden pocket"]["new_price"] == pytest.approx(200.05)

    assert diff["Flip support"]["status"] == "removed"
    assert diff["Flip support"]["old_price"] == pytest.approx(90.0)
    assert diff["Flip support"]["new_price"] is None


def test_move_threshold_boundary():
    # exactly at the threshold -> unchanged; just past it -> moved
    at_threshold = compute_diff([_level("X", 100.1)], [_level("X", 100.0)], move_threshold_pct=0.1)
    assert at_threshold[0]["status"] == "unchanged"

    past_threshold = compute_diff([_level("X", 100.11)], [_level("X", 100.0)], move_threshold_pct=0.1)
    assert past_threshold[0]["status"] == "moved"
