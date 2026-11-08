"""Preregistered SPY opening-range reclaim research.

This module implements only ``spy-or-reclaim-v1`` from
docs/SPY-RANGE-RECLAIM-PREREGISTRATION.md. It operates on underlying SPY
bars, never option premiums, and writes no live recommendation.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from math import inf
from typing import Literal

import pandas as pd

ET = "America/New_York"
TRAIN_END = pd.Timestamp("2025-11-08", tz=ET)
VALIDATION_END = pd.Timestamp("2026-05-08", tz=ET)
ROUND_TRIP_COST_BPS = 4
COST_STRESS_BPS = 8


@dataclass(frozen=True)
class Candidate:
    key: str
    opening_minutes: int
    target: Literal["midpoint", "opposite"]
    relative_volume: float


CANDIDATES = (
    Candidate("or15-mid-rvol100", 15, "midpoint", 1.00),
    Candidate("or30-mid-rvol100", 30, "midpoint", 1.00),
    Candidate("or30-mid-rvol125", 30, "midpoint", 1.25),
    Candidate("or30-opposite-rvol125", 30, "opposite", 1.25),
)


@dataclass(frozen=True)
class Trade:
    candidate: str
    direction: Literal["long", "short"]
    signal_time: pd.Timestamp
    entry_time: pd.Timestamp
    exit_time: pd.Timestamp
    entry: float
    stop: float
    target: float
    exit: float
    exit_reason: Literal["stop", "target", "time"]
    planned_reward_risk: float
    gross_return: float
    net_return_4bps: float
    net_return_8bps: float


def _regular_session(frame: pd.DataFrame) -> pd.DataFrame:
    required = {"open", "high", "low", "close", "volume"}
    if not required.issubset(frame.columns):
        raise ValueError(f"missing columns: {sorted(required - set(frame.columns))}")
    if frame.index.tz is None:
        raise ValueError("SPY bars must use a timezone-aware DatetimeIndex")
    ordered = frame.sort_index().copy()
    local = ordered.index.tz_convert(ET)
    mask = (local.dayofweek < 5) & (
        ((local.hour > 9) | ((local.hour == 9) & (local.minute >= 30)))
        & (local.hour < 16)
    )
    return ordered.loc[mask]


def _return(direction: str, entry: float, exit_price: float) -> float:
    return exit_price / entry - 1 if direction == "long" else entry / exit_price - 1


def _simulate_exit(day: pd.DataFrame, entry_position: int, direction: str, stop: float, target: float):
    remaining = day.iloc[entry_position:]
    local = remaining.index.tz_convert(ET)
    eligible = remaining[(local.hour < 15) | ((local.hour == 15) & (local.minute <= 45))]
    if eligible.empty:
        return None
    for timestamp, bar in eligible.iterrows():
        stop_hit = bar["low"] <= stop if direction == "long" else bar["high"] >= stop
        target_hit = bar["high"] >= target if direction == "long" else bar["low"] <= target
        # Five-minute OHLC cannot reveal intrabar order. Count the adverse
        # path first rather than granting an unknowable favorable fill.
        if stop_hit:
            return timestamp, float(stop), "stop"
        if target_hit:
            return timestamp, float(target), "target"
    timestamp = eligible.index[-1]
    return timestamp, float(eligible.iloc[-1]["close"]), "time"


def generate_trades(frame: pd.DataFrame, candidate: Candidate) -> list[Trade]:
    bars = _regular_session(frame)
    if bars.empty:
        return []
    bars["prior_median_volume"] = bars["volume"].rolling(20, min_periods=20).median().shift(1)
    local_index = bars.index.tz_convert(ET)
    trades: list[Trade] = []

    for _, day in bars.groupby(local_index.date):
        local = day.index.tz_convert(ET)
        opening_end_minutes = 9 * 60 + 30 + candidate.opening_minutes
        clock_minutes = local.hour * 60 + local.minute
        opening = day[(clock_minutes >= 9 * 60 + 30) & (clock_minutes < opening_end_minutes)]
        expected_opening_bars = candidate.opening_minutes // 5
        if len(opening) != expected_opening_bars:
            continue
        range_low = float(opening["low"].min())
        range_high = float(opening["high"].max())
        midpoint = (range_low + range_high) / 2
        signal_positions = [
            index for index, minute in enumerate(clock_minutes)
            if 10 * 60 <= minute <= 14 * 60 + 30
        ]

        for position in signal_positions:
            if position + 1 >= len(day):
                continue
            signal = day.iloc[position]
            prior_volume = signal["prior_median_volume"]
            if not pd.notna(prior_volume) or prior_volume <= 0:
                continue
            if float(signal["volume"]) < float(prior_volume) * candidate.relative_volume:
                continue
            direction = None
            if float(signal["low"]) < range_low and float(signal["close"]) > range_low:
                direction = "long"
            elif float(signal["high"]) > range_high and float(signal["close"]) < range_high:
                direction = "short"
            if direction is None:
                continue

            entry_time = day.index[position + 1]
            entry = float(day.iloc[position + 1]["open"])
            buffer = entry * 0.0005
            if direction == "long":
                stop = float(signal["low"]) - buffer
                target = midpoint if candidate.target == "midpoint" else range_high
                risk = entry - stop
                reward = target - entry
            else:
                stop = float(signal["high"]) + buffer
                target = midpoint if candidate.target == "midpoint" else range_low
                risk = stop - entry
                reward = entry - target
            if risk <= 0 or reward <= 0 or reward / risk < 1:
                continue

            result = _simulate_exit(day, position + 1, direction, stop, target)
            if result is None:
                continue
            exit_time, exit_price, exit_reason = result
            gross = _return(direction, entry, exit_price)
            trades.append(Trade(
                candidate=candidate.key,
                direction=direction,
                signal_time=day.index[position],
                entry_time=entry_time,
                exit_time=exit_time,
                entry=entry,
                stop=stop,
                target=target,
                exit=exit_price,
                exit_reason=exit_reason,
                planned_reward_risk=reward / risk,
                gross_return=gross,
                net_return_4bps=gross - ROUND_TRIP_COST_BPS / 10_000,
                net_return_8bps=gross - COST_STRESS_BPS / 10_000,
            ))
            break
    return trades


def _max_drawdown(returns: list[float]) -> float:
    equity = 1.0
    peak = 1.0
    worst = 0.0
    for value in returns:
        equity *= 1 + value
        peak = max(peak, equity)
        worst = max(worst, (peak - equity) / peak)
    return worst * 100


def summarize(trades: list[Trade], return_field: str = "net_return_8bps") -> dict:
    values = [float(getattr(trade, return_field)) for trade in trades]
    wins = [value for value in values if value > 0]
    losses = [value for value in values if value < 0]
    profit_factor = sum(wins) / abs(sum(losses)) if losses else inf if wins else 0.0
    directions = {}
    for direction in ("long", "short"):
        subset = [float(getattr(trade, return_field)) for trade in trades if trade.direction == direction]
        directions[direction] = {
            "trades": len(subset),
            "expectancy_pct": (sum(subset) / len(subset) * 100) if subset else None,
        }
    return {
        "trades": len(trades),
        "longs": directions["long"]["trades"],
        "shorts": directions["short"]["trades"],
        "win_rate_pct": (len(wins) / len(values) * 100) if values else None,
        "expectancy_pct": (sum(values) / len(values) * 100) if values else None,
        "profit_factor": None if profit_factor == inf else profit_factor,
        "profit_factor_infinite": profit_factor == inf,
        "max_drawdown_pct": _max_drawdown(values),
        "direction": directions,
    }


def partition(trades: list[Trade]) -> dict[str, list[Trade]]:
    result = {"train": [], "validation": [], "holdout": []}
    for trade in trades:
        local_time = trade.signal_time.tz_convert(ET)
        if local_time < TRAIN_END:
            result["train"].append(trade)
        elif local_time < VALIDATION_END:
            result["validation"].append(trade)
        else:
            result["holdout"].append(trade)
    return result


def validation_passes(trades: list[Trade]) -> bool:
    base = summarize(trades, "net_return_4bps")
    stress = summarize(trades, "net_return_8bps")
    return bool(
        stress["trades"] >= 30
        and stress["longs"] >= 10
        and stress["shorts"] >= 10
        and base["expectancy_pct"] is not None and base["expectancy_pct"] > 0
        and stress["expectancy_pct"] is not None and stress["expectancy_pct"] > 0
        and (stress["profit_factor_infinite"] or (stress["profit_factor"] or 0) >= 1.20)
        and stress["max_drawdown_pct"] <= 8
        and stress["direction"]["long"]["expectancy_pct"] is not None
        and stress["direction"]["long"]["expectancy_pct"] >= 0
        and stress["direction"]["short"]["expectancy_pct"] is not None
        and stress["direction"]["short"]["expectancy_pct"] >= 0
    )


def historical_holdout_passes(trades: list[Trade]) -> bool:
    ordered = sorted(trades, key=lambda trade: trade.signal_time)
    midpoint = len(ordered) // 2
    halves = [summarize(ordered[:midpoint]), summarize(ordered[midpoint:])]
    result = summarize(ordered)
    return bool(
        result["trades"] >= 30
        and result["longs"] >= 10
        and result["shorts"] >= 10
        and result["expectancy_pct"] is not None and result["expectancy_pct"] > 0
        and (result["profit_factor_infinite"] or (result["profit_factor"] or 0) >= 1.10)
        and result["max_drawdown_pct"] <= 10
        and result["direction"]["long"]["expectancy_pct"] is not None
        and result["direction"]["long"]["expectancy_pct"] >= 0
        and result["direction"]["short"]["expectancy_pct"] is not None
        and result["direction"]["short"]["expectancy_pct"] >= 0
        and all(half["expectancy_pct"] is not None and half["expectancy_pct"] >= 0 for half in halves)
    )


def trade_to_dict(trade: Trade) -> dict:
    payload = asdict(trade)
    for key in ("signal_time", "entry_time", "exit_time"):
        payload[key] = payload[key].isoformat()
    return payload
