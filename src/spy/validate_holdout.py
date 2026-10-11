"""Out-of-sample check for src/spy/sweep.py's result: TREND_LOOKBACK=4/
DOJI_BODY_MAX_PCT<=0.30 won a 24-cell sweep against the full ~2-year
Alpaca sample, which is exactly the setup where an in-sample winner can
look better than it really is. This splits that same sample in half by
calendar date - an earlier TRAIN window and a later, completely untouched
HOLDOUT window - re-runs the sweep on TRAIN only, and checks whether
TRAIN's pick (and the currently-live default) still perform on HOLDOUT,
data neither was chosen against.

    python -m src.spy.validate_holdout

Writes no site data - this is a one-off analysis tool, like sweep.py.
"""

from itertools import product

import pandas as pd

import src.spy.exhaustion_signal as exhaustion_signal
from src.spy.backtest import run_backtest, summarize
from src.spy.fetch import ALPACA_HISTORY_DAYS, fetch_alpaca_5m, fetch_vix_daily
from src.spy.heikin_ashi import build_timeframes

TREND_LOOKBACK_VALUES = (2, 3, 4, 5)
DOJI_BODY_MAX_PCT_VALUES = (0.15, 0.20, 0.25, 0.30, 0.35, 0.40)
MIN_CONFIRMED = 1
MIN_RESOLVED_CONFIDENT = 30
LIVE_DEFAULT = (4, 0.30)  # what's actually deployed right now - see src/spy/exhaustion_signal.py
OLD_DEFAULT = (3, 0.30)   # what was deployed before the sweep - the honest baseline to beat


def _sweep(timeframes: dict, real_5m: pd.DataFrame, vix_daily: pd.Series) -> list[tuple]:
    rows = []
    for trend_lookback, doji_pct in product(TREND_LOOKBACK_VALUES, DOJI_BODY_MAX_PCT_VALUES):
        exhaustion_signal.TREND_LOOKBACK = trend_lookback
        exhaustion_signal.DOJI_BODY_MAX_PCT = doji_pct
        signals = exhaustion_signal.find_signals(timeframes)
        results = run_backtest(signals, real_5m, vix_daily, min_confirmed=MIN_CONFIRMED)
        s = summarize(results)
        rows.append((trend_lookback, doji_pct, len(signals), s))
    return rows


def _print_table(rows: list[tuple], label: str) -> None:
    header = (
        f"{'trend':>5} | {'doji%':>6} | {'signals':>7} | {'trades':>6} | {'resolved':>8} "
        f"| {'target%':>8} | {'stop%':>7} | {'avg ret%':>9}"
    )
    print(f"\n--- {label} ---")
    print(header)
    print("-" * len(header))
    for trend_lookback, doji_pct, n_signals, s in rows:
        if s["resolved"] == 0:
            print(
                f"{trend_lookback:>5} | {doji_pct:>6.2f} | {n_signals:>7} | {s['trades']:>6} "
                f"| {s['resolved']:>8} |        - |       - |         -"
            )
            continue
        print(
            f"{trend_lookback:>5} | {doji_pct:>6.2f} | {n_signals:>7} | {s['trades']:>6} | {s['resolved']:>8} | "
            f"{s['target_hit_rate_pct']:>7.1f}% | {s['stop_hit_rate_pct']:>6.1f}% | {s['avg_pct_return']:>8.2f}%"
        )


def main() -> int:
    print(f"Fetching SPY 5m candles ({ALPACA_HISTORY_DAYS}d, Alpaca) and VIX daily (Yahoo)...")
    real_5m = fetch_alpaca_5m("SPY")
    vix_daily = fetch_vix_daily()
    print(f"  {len(real_5m)} SPY 5m candles, {real_5m.index[0]} -> {real_5m.index[-1]}")

    split_date = (real_5m.index[0] + (real_5m.index[-1] - real_5m.index[0]) / 2).normalize()
    train_5m = real_5m[real_5m.index < split_date]
    holdout_5m = real_5m[real_5m.index >= split_date]
    print(f"Split at {split_date.date()}: TRAIN {len(train_5m)} candles, HOLDOUT {len(holdout_5m)} candles")

    print("Building Heikin-Ashi timeframes for each half independently...")
    train_tf = build_timeframes(train_5m)
    holdout_tf = build_timeframes(holdout_5m)

    train_rows = _sweep(train_tf, train_5m, vix_daily)
    _print_table(train_rows, "TRAIN (first half) - sweep result")

    confident = [r for r in train_rows if r[3].get("resolved", 0) >= MIN_RESOLVED_CONFIDENT]
    if confident:
        best = max(confident, key=lambda r: r[3]["avg_pct_return"])
        train_pick = (best[0], best[1])
        print(
            f"\nTRAIN's pick (>= {MIN_RESOLVED_CONFIDENT} resolved): trend={best[0]}, doji<={best[1]:.2f} "
            f"-> {best[3]['resolved']} resolved, {best[3]['avg_pct_return']:.2f}% avg return"
        )
    else:
        train_pick = None
        print(f"\nNo TRAIN cell reached {MIN_RESOLVED_CONFIDENT} resolved trades - nothing confidently pickable.")

    holdout_rows = _sweep(holdout_tf, holdout_5m, vix_daily)
    _print_table(holdout_rows, "HOLDOUT (second half) - same grid, never used to pick anything")

    def _find(rows, trend, doji):
        for t, d, n, s in rows:
            if t == trend and abs(d - doji) < 1e-9:
                return n, s
        return None, None

    print("\n--- Out-of-sample check ---")
    for name, (trend, doji) in (("OLD_DEFAULT (pre-sweep)", OLD_DEFAULT), ("LIVE_DEFAULT (post-sweep)", LIVE_DEFAULT)):
        n, s = _find(holdout_rows, trend, doji)
        if s and s["resolved"] > 0:
            print(
                f"{name} trend={trend}/doji<={doji:.2f} on HOLDOUT: {s['resolved']} resolved, "
                f"{s['avg_pct_return']:.2f}% avg return, {s['target_hit_rate_pct']:.1f}% target-hit rate"
            )
        else:
            print(f"{name} trend={trend}/doji<={doji:.2f} on HOLDOUT: no resolved trades")

    if train_pick:
        n, s = _find(holdout_rows, *train_pick)
        if s and s["resolved"] > 0:
            print(
                f"TRAIN's own pick trend={train_pick[0]}/doji<={train_pick[1]:.2f} on HOLDOUT: "
                f"{s['resolved']} resolved, {s['avg_pct_return']:.2f}% avg return"
            )

    exhaustion_signal.TREND_LOOKBACK = 4
    exhaustion_signal.DOJI_BODY_MAX_PCT = 0.30
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
