import json
from pathlib import Path

import pandas as pd

from src.levels.structural_reclaim import (
    METHOD_VERSION,
    detect_structural_reclaim,
)


def _candles(last_closes=(75_900.0, 75_700.0)) -> pd.DataFrame:
    index = pd.date_range("2026-05-01", "2026-11-07", freq="D", tz="UTC")
    frame = pd.DataFrame(
        {
            "open": 75_000.0,
            "high": 76_000.0,
            "low": 74_000.0,
            "close": 75_000.0,
            "volume": 1.0,
        },
        index=index,
    )
    # Four distinct confirmed pivot highs in one structural cluster. The
    # May 6 high is the exact $82,790.90 source that rounds to $82,800.
    for date, price in {
        "2026-05-06": 82_790.9,
        "2026-08-28": 81_461.0,
        "2026-09-03": 82_288.1,
        "2026-10-29": 81_882.0,
    }.items():
        frame.loc[date, "high"] = price
    # A newer but unconfirmed extreme must not replace repeat-tested structure.
    frame.loc["2026-10-15", "high"] = 90_000.0
    frame.iloc[-2, frame.columns.get_loc("close")] = last_closes[0]
    frame.iloc[-1, frame.columns.get_loc("close")] = last_closes[1]
    return frame


def test_reconstructs_the_repeat_tested_may_range_high():
    result = detect_structural_reclaim(_candles(), pivot_n=1)

    assert result is not None
    assert result["method_version"] == METHOD_VERSION
    assert result["quality"] == "established"
    assert result["boundary"]["exact_price"] == 82_790.9
    assert result["boundary"]["display_price"] == 82_800
    assert result["boundary"]["origin_date"] == "2026-05-06"
    assert result["boundary"]["pivot_count"] == 4
    assert result["boundary"]["distinct_months"] == 4
    assert result["boundary"]["last_test_date"] == "2026-10-29"
    assert result["acceptance"]["state"] == "accepted-below"


def test_acceptance_is_an_explicit_completed_close_proxy():
    result = detect_structural_reclaim(
        _candles(last_closes=(83_100.0, 83_400.0)),
        pivot_n=1,
    )

    assert result is not None
    assert result["acceptance"]["state"] == "accepted-above"
    assert result["acceptance"]["rule"] == "2 consecutive completed Daily closes"


def test_refuses_to_publish_an_unconfirmed_single_high():
    frame = _candles()
    for date in ("2026-08-28", "2026-09-03", "2026-10-29"):
        frame.loc[date, "high"] = 76_000.0

    assert detect_structural_reclaim(frame, pivot_n=1) is None


def test_published_btc_snapshot_matches_the_completed_daily_candles():
    root = Path(__file__).resolve().parents[1]
    with (root / "site/data/btc_candles_1d.json").open() as handle:
        rows = json.load(handle)
    candles = pd.DataFrame(rows)
    candles.index = pd.to_datetime(candles.pop("time"), unit="s", utc=True)
    calculated = detect_structural_reclaim(candles)
    with (root / "site/data/btc_levels.json").open() as handle:
        published = json.load(handle)["structural_reclaim"]

    assert calculated is not None
    assert published["method_version"] == calculated["method_version"]
    assert published["boundary"] == calculated["boundary"]
    assert published["acceptance"] == calculated["acceptance"]
