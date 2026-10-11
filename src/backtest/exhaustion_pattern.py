"""Historical reversal-rate backtest for the daily exhaustion pattern
defined in src/levels/exhaustion_pattern.py.

Reuses the same touch/hold/break-style thresholds as every other level on
this site (config.BACKTEST_FORWARD_DAYS / BACKTEST_HOLD_MOVE_PCT /
BACKTEST_BREAK_CLOSE_PCT) and the exact same output shape as one entry of
src/backtest/scorecard.py's per-level-type dict - "hold" here means price
moved in the direction the pattern called (a reversal), "break" means the
original trend continued instead. Reusing that shape means this drops
straight into {asset}_scorecard.json and renders in the existing scorecard
table (site/app.js's renderScorecardTable) with zero site changes, the same
way "Round number" already does despite not being a data-derived level
either.
"""

from dataclasses import dataclass

import pandas as pd

import config
from src.levels.exhaustion_pattern import find_exhaustion_days


@dataclass
class PatternOutcome:
    result: str | None  # "hold" (reversed as called), "break" (trend continued), "inconclusive", or None (no forward data at all)
    move_pct: float | None


def _classify_one(direction: str, entry_close: float, future_candles: pd.DataFrame) -> PatternOutcome:
    if future_candles.empty:
        return PatternOutcome(result=None, move_pct=None)

    is_bullish_call = direction == "bullish_reversal"  # expects price to move UP from here
    hold_threshold = (
        entry_close * (1 + config.BACKTEST_HOLD_MOVE_PCT / 100)
        if is_bullish_call
        else entry_close * (1 - config.BACKTEST_HOLD_MOVE_PCT / 100)
    )
    break_threshold = (
        entry_close * (1 - config.BACKTEST_BREAK_CLOSE_PCT / 100)
        if is_bullish_call
        else entry_close * (1 + config.BACKTEST_BREAK_CLOSE_PCT / 100)
    )

    for i in range(len(future_candles)):
        close = float(future_candles.iloc[i]["close"])
        held = close >= hold_threshold if is_bullish_call else close <= hold_threshold
        broke = close <= break_threshold if is_bullish_call else close >= break_threshold
        move_pct = (close - entry_close) / entry_close * 100
        if held:
            return PatternOutcome(result="hold", move_pct=move_pct)
        if broke:
            return PatternOutcome(result="break", move_pct=move_pct)

    return PatternOutcome(result="inconclusive", move_pct=None)


def build_exhaustion_scorecard_entry(candles_1d: pd.DataFrame) -> dict:
    occurrences = find_exhaustion_days(candles_1d)

    touches = 0
    holds = 0
    breaks = 0
    inconclusive = 0
    hold_moves: list[float] = []
    break_moves: list[float] = []

    for occ in occurrences:
        entry_close = float(candles_1d.iloc[occ.idx]["close"])
        future = candles_1d.iloc[occ.idx + 1 : occ.idx + 1 + config.BACKTEST_FORWARD_DAYS]
        outcome = _classify_one(occ.direction, entry_close, future)
        if outcome.result is None:
            continue  # ran off the end of the dataset with zero forward days - not a sample
        touches += 1
        if outcome.result == "hold":
            holds += 1
            hold_moves.append(outcome.move_pct)
        elif outcome.result == "break":
            breaks += 1
            break_moves.append(outcome.move_pct)
        else:
            inconclusive += 1

    resolved = holds + breaks

    def avg(values: list[float]) -> float | None:
        return sum(values) / len(values) if values else None

    return {
        "touches": touches,
        "resolved": resolved,
        "holds": holds,
        "breaks": breaks,
        "inconclusive": inconclusive,
        "hold_rate_pct": (holds / resolved * 100) if resolved else None,
        "avg_move_after_hold_pct": avg(hold_moves),
        "avg_move_after_break_pct": avg(break_moves),
        "low_confidence": resolved < config.BACKTEST_MIN_TOUCHES_CONFIDENT,
    }
