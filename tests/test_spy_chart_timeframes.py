import json
from pathlib import Path

import pandas as pd
import pytest

from src.spy.chart_timeframes import CHART_TIMEFRAMES_MINUTES, build_chart_timeframes
from src.spy.export import build_spy_chart_payload
from src.spy import fetch as spy_fetch


def _minutes(start: str, count: int) -> pd.DataFrame:
    index = pd.date_range(start, periods=count, freq="1min", tz="UTC")
    values = list(range(count))
    return pd.DataFrame(
        {
            "open": values,
            "high": [value + 2 for value in values],
            "low": [value - 2 for value in values],
            "close": [value + 1 for value in values],
            "volume": [10] * count,
        },
        index=index,
    )


def test_all_requested_spy_intervals_use_regular_session_and_real_1m_bars():
    # 9:30 AM–4 PM EST, with one premarket and one after-hours print.
    source = _minutes("2026-11-10 14:29", 392)
    frames = build_chart_timeframes(source, pd.Timestamp("2026-11-10T21:01:00Z"))

    assert tuple(frames) == CHART_TIMEFRAMES_MINUTES == (1, 5, 10, 15, 20, 30, 60, 240)
    assert {minutes: len(frame) for minutes, frame in frames.items()} == {
        1: 390, 5: 78, 10: 39, 15: 26, 20: 20, 30: 13, 60: 7, 240: 2,
    }
    assert frames[1].index[0] == pd.Timestamp("2026-11-10T14:31:00Z")
    assert frames[1].iloc[0]["open"] == 1  # never reuse the 9:29 premarket print
    assert frames[5].iloc[0]["close"] == 6
    assert frames[240].iloc[-1]["close"] == 391
    assert all(frame.index[-1] == pd.Timestamp("2026-11-10T21:00:00Z") for frame in frames.values())


def test_unfinished_bins_wait_for_their_real_close_and_missing_minutes_stay_missing():
    source = _minutes("2026-07-08 13:30", 77).drop(pd.Timestamp("2026-07-08T13:36:00Z"))
    frames = build_chart_timeframes(source, pd.Timestamp("2026-07-08T14:47:30Z"))

    assert len(frames[1]) == 76
    assert pd.Timestamp("2026-07-08T13:37:00Z") not in frames[1].index
    assert frames[5].index[-1] == pd.Timestamp("2026-07-08T14:45:00Z")
    assert frames[10].index[-1] == pd.Timestamp("2026-07-08T14:40:00Z")
    assert frames[60].index[-1] == pd.Timestamp("2026-07-08T14:30:00Z")
    assert frames[240].empty


def test_spy_payload_has_all_seven_batch_intervals_without_changing_research_source():
    source = _minutes("2026-11-10 14:30", 390)
    payload, complete = build_spy_chart_payload(source, source.iloc[::5], pd.Timestamp("2026-11-10T21:00:00Z"))

    assert payload["is_live"] is False
    assert payload["price"] == payload["timeframes"]["1"][-1]["close"]
    assert set(payload["timeframes"]) == set(complete) == {str(value) for value in CHART_TIMEFRAMES_MINUTES}
    assert all(payload["timeframes"][key] == complete[key] for key in complete)
    assert "IEX" in payload["source"] and "regular session" in payload["source"]
    assert payload["range_context"]["is_signal"] is False


def test_naive_source_or_generation_time_is_rejected():
    source = _minutes("2026-11-10 14:30", 3)
    with pytest.raises(ValueError, match="timezone-aware"):
        build_chart_timeframes(source.tz_localize(None), pd.Timestamp("2026-11-10T15:00:00Z"))
    with pytest.raises(ValueError, match="timezone-aware"):
        build_chart_timeframes(source, pd.Timestamp("2026-11-10T15:00:00"))


def test_one_minute_fetch_uses_the_real_iex_interval_and_all_pages(monkeypatch):
    calls = []

    class Response:
        def __init__(self, payload):
            self.payload = payload

        def raise_for_status(self):
            pass

        def json(self):
            return self.payload

    pages = [
        {"bars": [{"t": "2026-11-10T14:30:00Z", "o": 1, "h": 2, "l": 1, "c": 2, "v": 10}], "next_page_token": "next"},
        {"bars": [{"t": "2026-11-10T14:31:00Z", "o": 2, "h": 3, "l": 2, "c": 3, "v": 11}], "next_page_token": None},
    ]

    def fake_get(url, params, headers, timeout):
        calls.append((url, params.copy()))
        return Response(pages[len(calls) - 1])

    monkeypatch.setattr(spy_fetch, "_alpaca_headers", lambda: {})
    monkeypatch.setattr(spy_fetch.requests, "get", fake_get)
    frame = spy_fetch.fetch_alpaca_1m("SPY", days=1)
    assert len(frame) == 2
    assert frame.index[1] - frame.index[0] == pd.Timedelta(minutes=1)
    assert [params["timeframe"] for _, params in calls] == ["1Min", "1Min"]
    assert [params.get("page_token") for _, params in calls] == [None, "next"]
    assert all(params["feed"] == "iex" for _, params in calls)


def test_published_spy_chart_and_monthly_archive_cover_every_interval():
    data_dir = Path(__file__).resolve().parents[1] / "site" / "data"
    payload = json.loads((data_dir / "spy_chart.json").read_text())
    manifest = json.loads((data_dir / "archive/spy/manifest.json").read_text())
    expected = {str(value) for value in CHART_TIMEFRAMES_MINUTES}
    assert payload["is_live"] is False
    assert set(payload["timeframes"]) == set(manifest["timeframes"]) == expected

    for minutes in expected:
        recent = payload["timeframes"][minutes]
        entries = manifest["timeframes"][minutes]
        assert recent and entries
        assert all(left["time"] < right["time"] for left, right in zip(recent, recent[1:]))
        previous_last = None
        for entry in entries:
            rows = json.loads((data_dir / entry["path"]).read_text())
            assert len(rows) == entry["count"] > 0
            assert rows[0]["time"] == entry["first"]
            assert rows[-1]["time"] == entry["last"]
            assert previous_last is None or previous_last < entry["first"]
            assert all(left["time"] < right["time"] for left, right in zip(rows, rows[1:]))
            assert all(bar["low"] <= min(bar["open"], bar["close"])
                       <= max(bar["open"], bar["close"]) <= bar["high"] for bar in rows)
            previous_last = entry["last"]
        assert recent[-1]["time"] == previous_last
