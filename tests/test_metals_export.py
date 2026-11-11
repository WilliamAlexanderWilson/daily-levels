import pandas as pd

from src.metals.export import TIMEFRAMES, _resample, build_payload


def test_xau_payload_is_disclosed_batch_benchmark_with_all_timeframes():
    index = pd.date_range("2026-01-01", periods=20 * 24 * 4 + 8, freq="15min", tz="UTC")
    frame = pd.DataFrame(
        {
            "open": range(len(index)),
            "high": [value + 2 for value in range(len(index))],
            "low": [value - 1 for value in range(len(index))],
            "close": [value + 1 for value in range(len(index))],
            "volume": [0.0] * len(index),
        },
        index=index,
    )
    generated_at = index[-1] + pd.Timedelta(minutes=15)
    payload = build_payload(frame, generated_at)

    assert payload["symbol"] == "XAU"
    assert payload["is_live"] is False
    assert "PF_XAUTUSD" in payload["source"]
    assert set(payload["timeframes"]) == {str(value) for value in TIMEFRAMES}
    assert len(payload["timeframes"]["240"]) < len(payload["timeframes"]["15"])
    assert payload["range_context"]["is_signal"] is False


def test_resampling_excludes_an_unfinished_higher_timeframe_bar():
    index = pd.date_range("2026-01-01T00:00:00Z", periods=5, freq="15min")
    frame = pd.DataFrame(
        {"open": 1, "high": 2, "low": 0, "close": 1.5, "volume": 0},
        index=index,
    )
    assert len(_resample(frame, 60)) == 1
    assert _resample(frame, 60).index[0] == pd.Timestamp("2026-01-01T00:00:00Z")
