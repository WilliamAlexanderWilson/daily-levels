"""Runs the exhaustion-reversal SPY options backtest and prints a results
table at every multi-timeframe confluence threshold (see
src/spy/exhaustion_signal.py for why that's a reported variable rather than
a baked-in guess).

    python -m src.spy.cli
"""

from src.spy.backtest import run_backtest, summarize
from src.spy.exhaustion_signal import find_signals
from src.spy.fetch import ALPACA_HISTORY_DAYS, fetch_alpaca_5m, fetch_vix_daily
from src.spy.heikin_ashi import build_timeframes


def main() -> int:
    print(f"Fetching SPY 5m candles ({ALPACA_HISTORY_DAYS}d, Alpaca) and VIX daily (Yahoo)...")
    real_5m = fetch_alpaca_5m("SPY")
    vix_daily = fetch_vix_daily()
    print(f"  {len(real_5m)} SPY 5m candles, {real_5m.index[0]} -> {real_5m.index[-1]}")

    print("Building 10m/15m/20m/30m Heikin-Ashi timeframes...")
    timeframes = build_timeframes(real_5m)

    print("Scanning for exhaustion signals (10:00-12:00 ET)...")
    signals = find_signals(timeframes)
    print(f"  {len(signals)} distinct signal events found")

    print()
    header = f"{'min TFs':>8} | {'trades':>6} | {'resolved':>8} | {'target%':>8} | {'stop%':>7} | {'avg ret%':>9}"
    print(header)
    print("-" * len(header))
    for min_confirmed in (1, 2, 3, 4):
        results = run_backtest(signals, real_5m, vix_daily, min_confirmed=min_confirmed)
        s = summarize(results)
        if s["resolved"] == 0:
            print(f"{min_confirmed:>8} | {s['trades']:>6} | {s['resolved']:>8} |        - |       - |         -")
            continue
        print(
            f"{min_confirmed:>8} | {s['trades']:>6} | {s['resolved']:>8} | "
            f"{s['target_hit_rate_pct']:>7.1f}% | {s['stop_hit_rate_pct']:>6.1f}% | {s['avg_pct_return']:>8.2f}%"
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
