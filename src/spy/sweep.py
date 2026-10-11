"""Parameter sweep over TREND_LOOKBACK x DOJI_BODY_MAX_PCT, re-run against
the real ~2-year Alpaca sample (see README "Next up" #3 - the original
sweep ran against the old 60-day Yahoo sample and had cells with as few as
3-5 trades, too thin to trust). Reuses the same fetch/signal/backtest
pipeline as cli.py; writes no site data, same as cli.py.

    python -m src.spy.sweep
"""

from itertools import product

import src.spy.exhaustion_signal as exhaustion_signal
from src.spy.backtest import run_backtest, summarize
from src.spy.fetch import ALPACA_HISTORY_DAYS, fetch_alpaca_5m, fetch_vix_daily
from src.spy.heikin_ashi import build_timeframes

TREND_LOOKBACK_VALUES = (2, 3, 4, 5)
DOJI_BODY_MAX_PCT_VALUES = (0.15, 0.20, 0.25, 0.30, 0.35, 0.40)
MIN_CONFIRMED = 1  # the >=2+ tiers are too thin to tune against - see README
MIN_RESOLVED_CONFIDENT = 30  # same bar the crypto backtest uses for low-confidence flagging


def main() -> int:
    print(f"Fetching SPY 5m candles ({ALPACA_HISTORY_DAYS}d, Alpaca) and VIX daily (Yahoo)...")
    real_5m = fetch_alpaca_5m("SPY")
    vix_daily = fetch_vix_daily()
    print(f"  {len(real_5m)} SPY 5m candles, {real_5m.index[0]} -> {real_5m.index[-1]}")

    print("Building 10m/15m/20m/30m Heikin-Ashi timeframes (independent of sweep params)...")
    timeframes = build_timeframes(real_5m)

    header = (
        f"{'trend':>5} | {'doji%':>6} | {'signals':>7} | {'trades':>6} | {'resolved':>8} "
        f"| {'target%':>8} | {'stop%':>7} | {'avg ret%':>9}"
    )
    print()
    print(header)
    print("-" * len(header))

    rows = []
    for trend_lookback, doji_pct in product(TREND_LOOKBACK_VALUES, DOJI_BODY_MAX_PCT_VALUES):
        exhaustion_signal.TREND_LOOKBACK = trend_lookback
        exhaustion_signal.DOJI_BODY_MAX_PCT = doji_pct
        signals = exhaustion_signal.find_signals(timeframes)
        results = run_backtest(signals, real_5m, vix_daily, min_confirmed=MIN_CONFIRMED)
        s = summarize(results)
        rows.append((trend_lookback, doji_pct, len(signals), s))
        if s["resolved"] == 0:
            print(
                f"{trend_lookback:>5} | {doji_pct:>6.2f} | {len(signals):>7} | {s['trades']:>6} "
                f"| {s['resolved']:>8} |        - |       - |         -"
            )
            continue
        print(
            f"{trend_lookback:>5} | {doji_pct:>6.2f} | {len(signals):>7} | {s['trades']:>6} | {s['resolved']:>8} | "
            f"{s['target_hit_rate_pct']:>7.1f}% | {s['stop_hit_rate_pct']:>6.1f}% | {s['avg_pct_return']:>8.2f}%"
        )

    # Restore defaults - nothing else runs in this process after this, but
    # leaving the module mutated would be a surprise for anything that did.
    exhaustion_signal.TREND_LOOKBACK = 3
    exhaustion_signal.DOJI_BODY_MAX_PCT = 0.30

    print()
    confident = [r for r in rows if r[3].get("resolved", 0) >= MIN_RESOLVED_CONFIDENT]
    if confident:
        best = max(confident, key=lambda r: r[3]["avg_pct_return"])
        print(
            f"Best avg return among cells with >={MIN_RESOLVED_CONFIDENT} resolved trades: "
            f"trend={best[0]}, doji<={best[1]:.2f} -> {best[3]['resolved']} resolved, "
            f"{best[3]['avg_pct_return']:.2f}% avg return, {best[3]['target_hit_rate_pct']:.1f}% target-hit rate"
        )
    else:
        print(f"No cell reached {MIN_RESOLVED_CONFIDENT} resolved trades - every result here is low-confidence.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
