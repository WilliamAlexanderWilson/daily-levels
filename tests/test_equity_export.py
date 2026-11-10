import pandas as pd

from src.equities.export import build_chart_payload


def test_equity_payload_is_explicitly_batch_and_symbol_scoped():
    index = pd.date_range("2026-11-09 14:30", periods=12, freq="5min", tz="UTC")
    frame = pd.DataFrame(
        {
            "open": range(100, 112),
            "high": range(101, 113),
            "low": range(99, 111),
            "close": range(100, 112),
            "volume": [1000] * 12,
        },
        index=index,
    )
    generated = pd.Timestamp("2026-11-10T00:00:00Z")
    payload = build_chart_payload("QQQ", frame, generated)
    assert payload["symbol"] == "QQQ"
    assert payload["is_live"] is False
    assert payload["price"] == 111.0
    assert set(payload["timeframes"]) == {"10", "15", "20", "30"}
    source_latest = int(frame.index.max().timestamp())
    assert all(
        bar["time"] <= source_latest
        for bars in payload["timeframes"].values()
        for bar in bars
    )
