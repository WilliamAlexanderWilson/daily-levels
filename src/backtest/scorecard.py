"""Aggregates per-day outcomes into a scorecard: for each level type, how
often it was touched, how often that resolved as a hold vs. a break, and
the average move after each.

A confluence-merged level's outcome is attributed to every one of its
constituent named levels (e.g. an outcome for "VAH (60d) + Prior month
low" counts toward both VAH and Prior month low) - they were the same
price zone that day, so the same outcome genuinely applies to each.
"""

from collections import defaultdict

import pandas as pd

import config
from src.backtest.outcomes import classify_outcome, forward_window
from src.backtest.replay import DaySnapshot


def build_scorecard(snapshots: list[DaySnapshot], candles_1d: pd.DataFrame) -> dict:
    stats: dict[str, dict] = defaultdict(
        lambda: {"touches": 0, "holds": 0, "breaks": 0, "inconclusive": 0, "hold_moves": [], "break_moves": []}
    )

    for snap in snapshots:
        future = forward_window(candles_1d, snap.date)
        for level in snap.levels:
            outcome = classify_outcome(level, future)
            if not outcome.touched:
                continue

            for kind in level["name"].split(" + "):
                s = stats[kind]
                s["touches"] += 1
                if outcome.result == "hold":
                    s["holds"] += 1
                    s["hold_moves"].append(outcome.move_pct)
                elif outcome.result == "break":
                    s["breaks"] += 1
                    s["break_moves"].append(outcome.move_pct)
                else:
                    s["inconclusive"] += 1

    def avg(values: list[float]) -> float | None:
        return sum(values) / len(values) if values else None

    scorecard = {}
    for kind, s in stats.items():
        resolved = s["holds"] + s["breaks"]
        scorecard[kind] = {
            "touches": s["touches"],
            "resolved": resolved,
            "holds": s["holds"],
            "breaks": s["breaks"],
            "inconclusive": s["inconclusive"],
            "hold_rate_pct": (s["holds"] / resolved * 100) if resolved else None,
            "avg_move_after_hold_pct": avg(s["hold_moves"]),
            "avg_move_after_break_pct": avg(s["break_moves"]),
            "low_confidence": resolved < config.BACKTEST_MIN_TOUCHES_CONFIDENT,
        }

    return scorecard
