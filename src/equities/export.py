"""Export clean QQQ and NVDA chart datasets from Alpaca's free IEX feed.

These are context charts only. SPY's separate research/backtest artifacts are
not copied to other symbols, and no order or live-trading endpoint is used.
"""

import pandas as pd

import config
from src.chart_archive import write_monthly_archive
from src.equities.range_context import build_range_context
from src.output import atomic_write_json
from src.spy.export import CHART_DISPLAY_DAYS, _frame_to_json
from src.spy.fetch import ALPACA_HISTORY_DAYS, fetch_alpaca_5m
from src.spy.heikin_ashi import TIMEFRAMES_MINUTES, build_timeframes

SYMBOLS = ("QQQ", "NVDA")


def build_chart_payload(symbol: str, frame: pd.DataFrame, generated_at: pd.Timestamp) -> dict:
    timeframes = build_timeframes(frame)
    completed_cutoff = min(frame.index.max(), generated_at)
    return {
        "symbol": symbol,
        "generated_at_utc": generated_at.isoformat(),
        "price": float(frame["close"].iloc[-1]),
        "source": "Alpaca historical bars (free IEX feed)",
        "is_live": False,
        "range_context": build_range_context(frame, float(frame["close"].iloc[-1]), generated_at),
        "timeframes": {
            # The shared resampler labels bars at the right edge. A 30-minute
            # bin that has only received 10 minutes of source data therefore
            # carries a future label and must not be published as complete.
            str(minutes): _frame_to_json(
                timeframes[minutes][timeframes[minutes].index <= completed_cutoff],
                CHART_DISPLAY_DAYS,
            )
            for minutes in TIMEFRAMES_MINUTES
        },
    }


def build_complete_timeframes(frame: pd.DataFrame, generated_at: pd.Timestamp) -> dict[str, list[dict]]:
    timeframes = build_timeframes(frame)
    completed_cutoff = min(frame.index.max(), generated_at)
    return {
        str(minutes): _frame_to_json(
            timeframes[minutes][timeframes[minutes].index <= completed_cutoff],
            ALPACA_HISTORY_DAYS,
        )
        for minutes in TIMEFRAMES_MINUTES
    }


def main() -> int:
    generated_at = pd.Timestamp.now(tz="UTC")
    for symbol in SYMBOLS:
        print(f"Fetching {symbol} 5m candles ({ALPACA_HISTORY_DAYS}d, Alpaca IEX)...")
        frame = fetch_alpaca_5m(symbol)
        payload = build_chart_payload(symbol, frame, generated_at)
        atomic_write_json(f"{config.DATA_DIR}/{symbol.lower()}_chart.json", payload)
        write_monthly_archive(symbol.lower(), build_complete_timeframes(frame, generated_at), payload["source"])
        print(f"  wrote {symbol} chart ({len(frame)} source bars)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
