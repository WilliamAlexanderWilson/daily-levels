"""Entry point: fetch SPY (Alpaca) /VIX (Yahoo), detect exhaustion signals,
run the options backtest, and write the static JSON the frontend reads.
Neither source sends a CORS header usable from the browser (Alpaca needs
an auth header anyway; Yahoo's chart endpoint was confirmed live to have
none), so unlike BTC/ETH this can't be polled live from the browser - it's
baked once per cron run, same as the crypto level engine, and goes stale
on the same schedule (~3h, best-effort).

Signal detection and the backtest run over the FULL fetched history
(ALPACA_HISTORY_DAYS, ~2 years) for real sample size. The exported CHART
itself is deliberately trimmed to CHART_DISPLAY_DAYS - showing two years of
10-minute candles would be both an enormous JSON payload committed to git
on every cron run and visually unreadable (thousands of slivers), and
nobody needs to see that far back on an intraday chart anyway. The signal
list and backtest stats are computed from the full window regardless of
what the chart displays.

    python -m src.spy.export
"""

import pandas as pd

import config
from src.output import atomic_write_json
from src.spy.backtest import run_backtest, summarize
from src.spy.exhaustion_signal import find_signals
from src.spy.fetch import ALPACA_HISTORY_DAYS, fetch_alpaca_5m, fetch_vix_daily
from src.spy.heikin_ashi import TIMEFRAMES_MINUTES, build_timeframes

SYMBOL = "SPY"
CONFLUENCE_LEVELS = (1, 2, 3, 4)
CHART_DISPLAY_DAYS = 60  # what actually gets drawn - independent of how deep the backtest's own sample goes


def _frame_to_json(frame: pd.DataFrame, display_days: int) -> list[dict]:
    if len(frame):
        cutoff = frame.index.max() - pd.Timedelta(days=display_days)
        frame = frame[frame.index >= cutoff]
    return [
        {
            "time": int(ts.timestamp()),
            "open": row["ha_open"],
            "high": row["ha_high"],
            "low": row["ha_low"],
            "close": row["ha_close"],
        }
        for ts, row in frame.iterrows()
    ]


def _signal_to_json(result, signal_direction_lookup) -> dict:
    return {
        "signal_time": int(result.signal_time.timestamp()),
        "direction": result.direction,
        "n_confirmed": result.n_confirmed,
        "confirmed_timeframes": result.confirmed_timeframes,
        "entry_underlying": result.entry_underlying,
        "strike": result.strike,
        "expiry_date": str(result.expiry_date) if result.expiry_date else None,
        "entry_premium": None if result.entry_premium != result.entry_premium else result.entry_premium,  # NaN guard
        "exit_time": int(result.exit_time.timestamp()),
        "exit_underlying": result.exit_underlying,
        "exit_premium": None if result.exit_premium != result.exit_premium else result.exit_premium,
        "exit_reason": result.exit_reason,
        "pct_return": result.pct_return,
    }


def main() -> int:
    print(f"Fetching {SYMBOL} 5m candles ({ALPACA_HISTORY_DAYS}d, Alpaca) and VIX daily (Yahoo)...")
    real_5m = fetch_alpaca_5m(SYMBOL)
    vix_daily = fetch_vix_daily()
    print(f"  {len(real_5m)} candles, {real_5m.index[0]} -> {real_5m.index[-1]}")

    timeframes = build_timeframes(real_5m)
    signals = find_signals(timeframes)
    print(f"  {len(signals)} distinct signal events")

    generated_at_utc = pd.Timestamp.now(tz="UTC")
    price = float(real_5m["close"].iloc[-1])

    chart_payload = {
        "generated_at_utc": generated_at_utc.isoformat(),
        "price": price,
        "timeframes": {
            str(minutes): _frame_to_json(timeframes[minutes], CHART_DISPLAY_DAYS) for minutes in TIMEFRAMES_MINUTES
        },
    }
    atomic_write_json(f"{config.DATA_DIR}/spy_chart.json", chart_payload)

    all_trades = run_backtest(signals, real_5m, vix_daily, min_confirmed=1)
    signals_payload = {
        "generated_at_utc": generated_at_utc.isoformat(),
        "trades": [_signal_to_json(r, None) for r in all_trades],
    }
    atomic_write_json(f"{config.DATA_DIR}/spy_signals.json", signals_payload)

    backtest_payload = {
        "generated_at_utc": generated_at_utc.isoformat(),
        "data_window_days": ALPACA_HISTORY_DAYS,
        "by_min_confirmed": {
            str(n): summarize(run_backtest(signals, real_5m, vix_daily, min_confirmed=n))
            for n in CONFLUENCE_LEVELS
        },
    }
    atomic_write_json(f"{config.DATA_DIR}/spy_backtest.json", backtest_payload)

    print("  wrote spy_chart.json, spy_signals.json, spy_backtest.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
