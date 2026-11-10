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
    # Generation may precede the newest source row when a paginated fetch
    # crosses a timeframe boundary. No exported completed bar may be newer.
    generated = pd.Timestamp("2026-11-09T15:00:00Z")
    payload = build_chart_payload("QQQ", frame, generated)
    assert payload["symbol"] == "QQQ"
    assert payload["is_live"] is False
    assert payload["price"] == 111.0
    assert payload["range_context"]["available"] is False
    assert payload["range_context"]["is_signal"] is False
    assert set(payload["timeframes"]) == {"10", "15", "20", "30"}
    generated_unix = int(generated.timestamp())
    assert all(
        bar["time"] <= generated_unix
        for bars in payload["timeframes"].values()
        for bar in bars
    )
    regular_first = payload["timeframes"]["10"][0]
    assert regular_first["open"] == 100
    assert regular_first["close"] == 101
