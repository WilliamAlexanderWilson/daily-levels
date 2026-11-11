"""Entry point: fetch SPY (Alpaca) /VIX (Yahoo), detect exhaustion signals,
run the options backtest, and write the static JSON the frontend reads.
Neither source sends a CORS header usable from the browser (Alpaca needs
an auth header anyway; Yahoo's chart endpoint was confirmed live to have
none), so unlike BTC/ETH this can't be polled live from the browser - it's
baked once per cron run, same as the crypto level engine, and goes stale
on the same schedule (~3h, best-effort).

Signal detection and the backtest keep their 5-minute-input rules. The chart
uses separate 1-minute IEX source bars to publish its display intervals.
The browser starts with a fast recent payload; the complete configured
window is also published as monthly archive chunks that load on left scroll.

    python -m src.spy.export
"""

import json

import pandas as pd

import config
from src.chart_archive import write_monthly_archive
from src.equities.range_context import build_range_context
from src.output import atomic_write_json
from src.spy.backtest import run_backtest, summarize
from src.spy.exhaustion_signal import find_signals
from src.spy.chart_timeframes import CHART_TIMEFRAMES_MINUTES, build_chart_timeframes
from src.spy.fetch import ALPACA_HISTORY_DAYS, fetch_alpaca_1m, fetch_alpaca_5m, fetch_vix_daily
from src.spy.heikin_ashi import TIMEFRAMES_MINUTES, build_timeframes
from src.session_reactions.engine import build_reaction_payload
from src.session_reactions.forward import update_forward_payload

SYMBOL = "SPY"
CONFLUENCE_LEVELS = (1, 2, 3, 4)
CHART_DISPLAY_DAYS = 60  # shared QQQ/NVDA recent window; SPY uses per-interval windows below
SPY_CHART_INITIAL_DAYS = {1: 7, 5: 30, 10: 60, 15: 60, 20: 60, 30: 60, 60: 120, 240: 120}


def _frame_to_json(frame: pd.DataFrame, display_days: int | None) -> list[dict]:
    if len(frame) and display_days is not None:
        cutoff = frame.index.max() - pd.Timedelta(days=display_days)
        frame = frame[frame.index >= cutoff]
    return [
        {
            "time": int(ts.timestamp()),
            "open": row["open"],
            "high": row["high"],
            "low": row["low"],
            "close": row["close"],
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


def build_spy_chart_payload(
    real_1m: pd.DataFrame, real_5m: pd.DataFrame, generated_at_utc: pd.Timestamp
) -> tuple[dict, dict[str, list[dict]]]:
    chart_timeframes = build_chart_timeframes(real_1m, generated_at_utc)
    price = float(chart_timeframes[1]["close"].iloc[-1])
    complete_timeframes = {
        str(minutes): _frame_to_json(chart_timeframes[minutes], None) for minutes in CHART_TIMEFRAMES_MINUTES
    }
    chart_payload = {
        "generated_at_utc": generated_at_utc.isoformat(),
        "price": price,
        "symbol": SYMBOL,
        "source": "Alpaca 1-minute historical bars (free IEX feed, regular session)",
        "is_live": False,
        "range_context": build_range_context(real_5m, price, generated_at_utc),
        "timeframes": {
            str(minutes): _frame_to_json(chart_timeframes[minutes], SPY_CHART_INITIAL_DAYS[minutes])
            for minutes in CHART_TIMEFRAMES_MINUTES
        },
    }
    return chart_payload, complete_timeframes


def main() -> int:
    print(f"Fetching {SYMBOL} 1m chart and 5m research candles ({ALPACA_HISTORY_DAYS}d, Alpaca) and VIX daily (Yahoo)...")
    real_1m = fetch_alpaca_1m(SYMBOL)
    real_5m = fetch_alpaca_5m(SYMBOL)
    vix_daily = fetch_vix_daily()
    print(f"  {len(real_1m)} 1m chart candles; {len(real_5m)} 5m research candles")

    timeframes = build_timeframes(real_5m)
    signals = find_signals(timeframes)
    print(f"  {len(signals)} distinct signal events")

    generated_at_utc = pd.Timestamp.now(tz="UTC")
    chart_payload, complete_timeframes = build_spy_chart_payload(real_1m, real_5m, generated_at_utc)
    atomic_write_json(f"{config.DATA_DIR}/spy_chart.json", chart_payload, compact=True)
    write_monthly_archive("spy", complete_timeframes, chart_payload["source"])

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

    reaction_payload = build_reaction_payload(
        "spy",
        real_5m,
        5,
        "Alpaca historical SPY bars (IEX feed)",
        "https://docs.alpaca.markets/us/docs/historical-stock-data-1",
        "Free IEX data covers one U.S. exchange, not the consolidated SIP market; non-U.S. opens may have no SPY prints.",
    )
    atomic_write_json(f"{config.DATA_DIR}/spy_session_reactions.json", reaction_payload)

    forward_path = f"{config.DATA_DIR}/spy_range_open_forward.json"
    try:
        with open(forward_path) as handle:
            prior_forward = json.load(handle)
    except (OSError, ValueError):
        prior_forward = None
    forward_payload = update_forward_payload(
        "spy",
        real_5m,
        5,
        reaction_payload["source"],
        prior_forward,
    )
    atomic_write_json(forward_path, forward_payload)

    print("  wrote SPY chart, signals, backtest, session reactions, and range-open forward tracker")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
