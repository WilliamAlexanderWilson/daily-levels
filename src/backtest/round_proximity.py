"""Tests whether round numbers behave differently depending on how close
price actually gets before reacting - a proximity curve rather than one
aggregate hold rate. Reuses the exact same touch/hold/break classification
as the main scorecard (src/backtest/outcomes.py), just re-run at several
tolerance widths instead of one, all against the same replayed snapshots.

Each tier answers: "of the times price came within this fraction of a
round-number step, what fraction eventually held vs. broke through?"
Tighter tiers (closer approaches) have fewer samples by construction -
every touch in a tight tier is also counted in every wider tier, so the
tiers are not independent samples of each other.
"""

import pandas as pd

import config
from src.backtest.outcomes import classify_outcome, forward_window
from src.backtest.replay import DaySnapshot
from src.levels.round_numbers import nearest_round_numbers, round_number_step

PROXIMITY_TIERS = [1.0, 0.5, 0.25, 0.1, 0.05, 0.02]  # fraction of the round-number step


def build_proximity_curve(snapshots: list[DaySnapshot], candles_1d: pd.DataFrame) -> list[dict]:
    results = []
    for tier_fraction in PROXIMITY_TIERS:
        stats = {"touches": 0, "holds": 0, "breaks": 0, "inconclusive": 0}

        for snap in snapshots:
            price = snap.price
            step = round_number_step(price)
            tolerance = step * tier_fraction
            below, above = nearest_round_numbers(price)
            future = forward_window(candles_1d, snap.date)

            for round_price, level_type in ((below, "support"), (above, "resistance")):
                level = {
                    "price_low": round_price - tolerance,
                    "price_high": round_price + tolerance,
                    "type": level_type,
                }
                outcome = classify_outcome(level, future)
                if not outcome.touched:
                    continue
                stats["touches"] += 1
                if outcome.result == "hold":
                    stats["holds"] += 1
                elif outcome.result == "break":
                    stats["breaks"] += 1
                else:
                    stats["inconclusive"] += 1

        resolved = stats["holds"] + stats["breaks"]
        results.append(
            {
                "tolerance_fraction": tier_fraction,
                "touches": stats["touches"],
                "resolved": resolved,
                "holds": stats["holds"],
                "breaks": stats["breaks"],
                "hold_rate_pct": (stats["holds"] / resolved * 100) if resolved else None,
                "low_confidence": resolved < config.BACKTEST_MIN_TOUCHES_CONFIDENT,
            }
        )

    return results
