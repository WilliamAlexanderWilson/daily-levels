"""No-lookahead range-rejection backtest with chronological holdout.

The experiment asks one narrow question: after a range has already formed,
does a completed-candle rejection of its edge have positive expectancy to the
midpoint after conservative costs? It does not claim that a range will hold.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from math import inf

import pandas as pd

FEE_PER_SIDE = 0.0020
SLIPPAGE_PER_SIDE = 0.0005
EDGE_FRACTION = 0.10
STOP_ATR_MULTIPLE = 0.35
MIN_EDGE_TOUCHES = 2
MAX_NORMALIZED_SLOPE = 0.35
TRAIN_END = pd.Timestamp("2024-01-01T00:00:00Z")
VALIDATION_END = pd.Timestamp("2025-01-01T00:00:00Z")
HOLDOUT_END = pd.Timestamp("2026-11-06T04:00:00Z")
PAPER_TRACKING_VERSION = "range-rejection-v1"
EXIT_EXPERIMENT_VERSION = "range-exit-runner-v1"


@dataclass(frozen=True)
class RangeSpec:
    key: str
    label: str
    method: str
    lookback_bars: int
    minimum: float | None = None
    maximum: float | None = None


SPECS = (
    RangeSpec("fixed_2_4k", "$2k–$4k", "fixed_usd", 80, 2_000, 4_000),
    RangeSpec("fixed_5_10k", "$5k–$10k", "fixed_usd", 120, 5_000, 10_000),
    RangeSpec("percent_5_10", "5%–10%", "percent", 80, 0.05, 0.10),
    RangeSpec("percent_10_20", "10%–20%", "percent", 120, 0.10, 0.20),
    RangeSpec("atr_4_8", "4–8 ATR", "atr", 80, 4.0, 8.0),
    RangeSpec("structure", "Structure range", "structure", 120),
)


def _true_range(candles: pd.DataFrame) -> pd.Series:
    previous_close = candles["close"].shift(1)
    return pd.concat(
        [
            candles["high"] - candles["low"],
            (candles["high"] - previous_close).abs(),
            (candles["low"] - previous_close).abs(),
        ],
        axis=1,
    ).max(axis=1)


def _qualifies(spec: RangeSpec, low: float, high: float, atr: float) -> bool:
    width = high - low
    midpoint = (high + low) / 2
    if width <= 0 or midpoint <= 0 or atr <= 0:
        return False
    if spec.method == "fixed_usd":
        value = width
    elif spec.method == "percent":
        value = width / midpoint
    elif spec.method == "atr":
        value = width / atr
    else:
        return True
    return bool(spec.minimum <= value <= spec.maximum)


def _range_at(candles: pd.DataFrame, index: int, spec: RangeSpec, atr: pd.Series) -> dict | None:
    window = candles.iloc[index - spec.lookback_bars : index]
    if len(window) != spec.lookback_bars:
        return None
    low = float(window["low"].min())
    high = float(window["high"].max())
    width = high - low
    atr_value = float(atr.iloc[index - 1])
    if not _qualifies(spec, low, high, atr_value):
        return None

    edge = width * EDGE_FRACTION
    low_touches = int((window["low"] <= low + edge).sum())
    high_touches = int((window["high"] >= high - edge).sum())
    if low_touches < MIN_EDGE_TOUCHES or high_touches < MIN_EDGE_TOUCHES:
        return None

    # Compare the first and last 10% of closes. This avoids calling a strong
    # directional move a range while requiring no future information.
    sample = max(3, spec.lookback_bars // 10)
    drift = abs(float(window["close"].tail(sample).mean() - window["close"].head(sample).mean()))
    if drift / width > MAX_NORMALIZED_SLOPE:
        return None
    return {
        "low": low,
        "high": high,
        "midpoint": (low + high) / 2,
        "edge": edge,
        "atr": atr_value,
        "low_touches": low_touches,
        "high_touches": high_touches,
    }


def _latest_range_snapshot(candles: pd.DataFrame, spec: RangeSpec) -> dict:
    """Describe today's rolling range even when it does not qualify.

    This lets the UI explain why a popular definition is inactive instead of
    hiding it or drawing its boundaries as though it were a valid setup.
    """
    atr = _true_range(candles).rolling(14).mean()
    index = len(candles)
    window = candles.iloc[index - spec.lookback_bars : index]
    low = float(window["low"].min())
    high = float(window["high"].max())
    width = high - low
    midpoint = (high + low) / 2
    atr_value = float(atr.iloc[-1])
    edge = width * EDGE_FRACTION
    low_touches = int((window["low"] <= low + edge).sum())
    high_touches = int((window["high"] >= high - edge).sum())
    sample = max(3, spec.lookback_bars // 10)
    drift = abs(float(window["close"].tail(sample).mean() - window["close"].head(sample).mean()))
    width_matches = _qualifies(spec, low, high, atr_value)
    touches_match = low_touches >= MIN_EDGE_TOUCHES and high_touches >= MIN_EDGE_TOUCHES
    slope_matches = drift / width <= MAX_NORMALIZED_SLOPE if width else False
    active = width_matches and touches_match and slope_matches
    reasons = []
    if not width_matches:
        reasons.append("current width is outside this definition")
    if not touches_match:
        reasons.append("both edges do not have enough tests")
    if not slope_matches:
        reasons.append("price drift is too directional")
    return {
        "low": round(low, 2),
        "high": round(high, 2),
        "midpoint": round(midpoint, 2),
        "width": round(width, 2),
        "width_pct": round(width / midpoint * 100, 2),
        "width_atr": round(width / atr_value, 2),
        "low_touches": low_touches,
        "high_touches": high_touches,
        "active_now": active,
        "status": "Qualified range now" if active else "; ".join(reasons),
    }


def _signal(candle: pd.Series, range_state: dict) -> str | None:
    low_edge = range_state["low"] + range_state["edge"]
    high_edge = range_state["high"] - range_state["edge"]
    if candle["low"] <= low_edge and low_edge < candle["close"] < range_state["midpoint"]:
        return "long"
    if candle["high"] >= high_edge and range_state["midpoint"] < candle["close"] < high_edge:
        return "short"
    return None


def _trade_return(direction: str, entry: float, exit_price: float) -> float:
    gross = (exit_price - entry) / entry if direction == "long" else (entry - exit_price) / entry
    # Express both transaction fees relative to entry notional. The exit fee
    # changes with exit notional and therefore is not exactly a second flat
    # entry-price percentage when price moved during the trade.
    fees = FEE_PER_SIDE + (FEE_PER_SIDE * exit_price / entry)
    return gross - fees


def _run_trade(
    candles: pd.DataFrame,
    entry_index: int,
    direction: str,
    range_state: dict,
    max_hold_bars: int,
) -> tuple[dict, int]:
    raw_entry = float(candles.iloc[entry_index]["open"])
    entry = raw_entry * (1 + SLIPPAGE_PER_SIDE if direction == "long" else 1 - SLIPPAGE_PER_SIDE)
    target = range_state["midpoint"]
    stop = (
        range_state["low"] - STOP_ATR_MULTIPLE * range_state["atr"]
        if direction == "long"
        else range_state["high"] + STOP_ATR_MULTIPLE * range_state["atr"]
    )

    # A gap that opens beyond the invalidation is filled at that worse open.
    if (direction == "long" and entry >= target) or (direction == "short" and entry <= target):
        return {}, entry_index
    # The entry candle is holding bar one. A one-bar maximum therefore exits
    # at that candle's close, not the following candle's close.
    end_index = min(len(candles) - 1, entry_index + max_hold_bars - 1)
    exit_price = float(candles.iloc[end_index]["close"])
    reason = "time"
    exit_index = end_index
    for cursor in range(entry_index, end_index + 1):
        bar = candles.iloc[cursor]
        stop_hit = bar["low"] <= stop if direction == "long" else bar["high"] >= stop
        target_hit = bar["high"] >= target if direction == "long" else bar["low"] <= target
        if stop_hit:
            raw_exit = min(stop, float(bar["open"])) if direction == "long" else max(stop, float(bar["open"]))
            exit_price = raw_exit * (1 - SLIPPAGE_PER_SIDE if direction == "long" else 1 + SLIPPAGE_PER_SIDE)
            reason = "stop"
            exit_index = cursor
            break
        if target_hit:
            exit_price = target * (1 - SLIPPAGE_PER_SIDE if direction == "long" else 1 + SLIPPAGE_PER_SIDE)
            reason = "target"
            exit_index = cursor
            break

    if reason == "time":
        exit_price *= 1 - SLIPPAGE_PER_SIDE if direction == "long" else 1 + SLIPPAGE_PER_SIDE

    net_return = _trade_return(direction, entry, exit_price)
    risk_fraction = abs(entry - stop) / entry + (2 * FEE_PER_SIDE)
    return {
        "direction": direction,
        "signal_time": candles.index[entry_index - 1].isoformat(),
        "entry_time": candles.index[entry_index].isoformat(),
        "exit_time": candles.index[exit_index].isoformat(),
        "entry": round(entry, 2),
        "exit": round(exit_price, 2),
        "stop": round(stop, 2),
        "target": round(target, 2),
        "range_low": round(range_state["low"], 2),
        "range_high": round(range_state["high"], 2),
        "reason": reason,
        "return_pct": round(net_return * 100, 4),
        "r_multiple": round(net_return / risk_fraction, 4) if risk_fraction else 0.0,
    }, exit_index


def _run_runner_trade(
    candles: pd.DataFrame,
    entry_index: int,
    direction: str,
    range_state: dict,
    max_hold_bars: int,
) -> tuple[dict, int]:
    """Run the frozen 50%-midpoint / 50%-opposite-edge comparison."""
    raw_entry = float(candles.iloc[entry_index]["open"])
    entry = raw_entry * (1 + SLIPPAGE_PER_SIDE if direction == "long" else 1 - SLIPPAGE_PER_SIDE)
    midpoint = range_state["midpoint"]
    runner_target = range_state["high"] if direction == "long" else range_state["low"]
    stop = (
        range_state["low"] - STOP_ATR_MULTIPLE * range_state["atr"]
        if direction == "long"
        else range_state["high"] + STOP_ATR_MULTIPLE * range_state["atr"]
    )
    if (direction == "long" and entry >= midpoint) or (direction == "short" and entry <= midpoint):
        return {}, entry_index

    end_index = min(len(candles) - 1, entry_index + max_hold_bars - 1)
    midpoint_filled = False
    remaining = 1.0
    legs: list[dict] = []
    weighted_return_parts: list[float] = []
    weighted_exit_parts: list[float] = []
    exit_index = end_index

    def add_leg(size: float, raw_exit: float, reason: str, cursor: int) -> None:
        exit_price = raw_exit * (
            1 - SLIPPAGE_PER_SIDE if direction == "long" else 1 + SLIPPAGE_PER_SIDE
        )
        leg_return = _trade_return(direction, entry, exit_price)
        weighted_return_parts.append(size * leg_return)
        weighted_exit_parts.append(size * exit_price)
        legs.append({
            "size_pct": round(size * 100, 2),
            "reason": reason,
            "exit_time": candles.index[cursor].isoformat(),
            "exit": round(exit_price, 2),
            "return_pct": round(leg_return * 100, 4),
        })

    for cursor in range(entry_index, end_index + 1):
        bar = candles.iloc[cursor]
        stop_hit = bar["low"] <= stop if direction == "long" else bar["high"] >= stop
        midpoint_hit = bar["high"] >= midpoint if direction == "long" else bar["low"] <= midpoint
        runner_hit = (
            bar["high"] >= runner_target if direction == "long" else bar["low"] <= runner_target
        )

        # Pessimistic ordering: any stop/target collision closes all remaining
        # size at the stop before crediting either favorable target.
        if stop_hit:
            raw_stop = min(stop, float(bar["open"])) if direction == "long" else max(stop, float(bar["open"]))
            add_leg(remaining, raw_stop, "stop", cursor)
            remaining = 0.0
            exit_index = cursor
            break

        if not midpoint_filled and midpoint_hit:
            add_leg(0.5, midpoint, "midpoint", cursor)
            midpoint_filled = True
            remaining = 0.5
        if midpoint_filled and runner_hit:
            add_leg(remaining, runner_target, "runner", cursor)
            remaining = 0.0
            exit_index = cursor
            break

    if remaining:
        add_leg(remaining, float(candles.iloc[end_index]["close"]), "time", end_index)
        exit_index = end_index

    net_return = sum(weighted_return_parts)
    weighted_exit = sum(weighted_exit_parts)
    leg_reasons = [leg["reason"] for leg in legs]
    if "runner" in leg_reasons:
        reason = "runner"
    elif midpoint_filled and "stop" in leg_reasons:
        reason = "midpoint_then_stop"
    elif midpoint_filled and "time" in leg_reasons:
        reason = "midpoint_then_time"
    else:
        reason = leg_reasons[-1]
    risk_fraction = abs(entry - stop) / entry + (2 * FEE_PER_SIDE)
    return {
        "direction": direction,
        "signal_time": candles.index[entry_index - 1].isoformat(),
        "entry_time": candles.index[entry_index].isoformat(),
        "exit_time": candles.index[exit_index].isoformat(),
        "entry": round(entry, 2),
        "exit": round(weighted_exit, 2),
        "stop": round(stop, 2),
        "midpoint_target": round(midpoint, 2),
        "runner_target": round(runner_target, 2),
        "range_low": round(range_state["low"], 2),
        "range_high": round(range_state["high"], 2),
        "reason": reason,
        "legs": legs,
        "return_pct": round(net_return * 100, 4),
        "r_multiple": round(net_return / risk_fraction, 4) if risk_fraction else 0.0,
    }, exit_index


def backtest_spec(
    candles: pd.DataFrame,
    spec: RangeSpec,
    start: pd.Timestamp | None = None,
    end: pd.Timestamp | None = None,
) -> list[dict]:
    candles = candles.sort_index()
    if end is not None:
        candles = candles[candles.index < end]
    atr = _true_range(candles).rolling(14).mean()
    trades: list[dict] = []
    period_start_index = int(candles.index.searchsorted(start)) if start is not None else 0
    cursor = max(spec.lookback_bars, 15, period_start_index)
    while cursor < len(candles) - 1:
        state = _range_at(candles, cursor, spec, atr)
        direction = _signal(candles.iloc[cursor], state) if state else None
        if not direction:
            cursor += 1
            continue
        trade, exit_index = _run_trade(candles, cursor + 1, direction, state, spec.lookback_bars)
        if trade:
            trades.append(trade)
            cursor = exit_index + 1
        else:
            cursor += 1
    return trades


def backtest_runner_cohort(
    candles: pd.DataFrame,
    spec: RangeSpec,
    baseline_trades: list[dict],
    end: pd.Timestamp | None = None,
) -> list[dict]:
    """Apply the runner to the baseline's exact entry cohort.

    Runner observations may overlap. That is deliberate: this is a paired
    exit sensitivity, not a second strategy whose longer positions are allowed
    to suppress later signals and change the cohort being compared.
    """
    candles = candles.sort_index()
    if end is not None:
        candles = candles[candles.index < end]
    atr = _true_range(candles).rolling(14).mean()
    trades: list[dict] = []
    for baseline in baseline_trades:
        signal_time = pd.Timestamp(baseline["signal_time"])
        entry_time = pd.Timestamp(baseline["entry_time"])
        if signal_time not in candles.index or entry_time not in candles.index:
            raise ValueError("Baseline entry cohort falls outside the runner partition")
        signal_index = int(candles.index.get_loc(signal_time))
        entry_index = int(candles.index.get_loc(entry_time))
        if entry_index != signal_index + 1:
            raise ValueError("Runner comparison requires the same next-bar baseline entry")
        state = _range_at(candles, signal_index, spec, atr)
        direction = _signal(candles.iloc[signal_index], state) if state else None
        if direction != baseline["direction"]:
            raise ValueError("Baseline signal no longer reproduces for runner comparison")
        trade, _exit_index = _run_runner_trade(
            candles, entry_index, direction, state, spec.lookback_bars
        )
        if not trade or trade["entry_time"] != baseline["entry_time"]:
            raise ValueError("Runner comparison failed to preserve the baseline entry")
        trades.append(trade)
    return trades


def _paper_trade(
    candles: pd.DataFrame,
    entry_index: int,
    direction: str,
    range_state: dict,
    max_hold_bars: int,
) -> tuple[dict, int, bool]:
    """Evaluate a forward-paper trade without closing incomplete evidence.

    Historical backtests may cap a position at a partition boundary. A live
    paper record cannot do that: until the full holding window has elapsed,
    an untouched target/stop is an open position, not a time exit.
    """
    raw_entry = float(candles.iloc[entry_index]["open"])
    entry = raw_entry * (1 + SLIPPAGE_PER_SIDE if direction == "long" else 1 - SLIPPAGE_PER_SIDE)
    target = range_state["midpoint"]
    stop = (
        range_state["low"] - STOP_ATR_MULTIPLE * range_state["atr"]
        if direction == "long"
        else range_state["high"] + STOP_ATR_MULTIPLE * range_state["atr"]
    )
    if (direction == "long" and entry >= target) or (direction == "short" and entry <= target):
        return {}, entry_index, True

    final_required_index = entry_index + max_hold_bars - 1
    last_observed_index = min(len(candles) - 1, final_required_index)
    for cursor in range(entry_index, last_observed_index + 1):
        bar = candles.iloc[cursor]
        stop_hit = bar["low"] <= stop if direction == "long" else bar["high"] >= stop
        target_hit = bar["high"] >= target if direction == "long" else bar["low"] <= target
        if stop_hit:
            raw_exit = min(stop, float(bar["open"])) if direction == "long" else max(stop, float(bar["open"]))
            exit_price = raw_exit * (1 - SLIPPAGE_PER_SIDE if direction == "long" else 1 + SLIPPAGE_PER_SIDE)
            reason = "stop"
        elif target_hit:
            exit_price = target * (1 - SLIPPAGE_PER_SIDE if direction == "long" else 1 + SLIPPAGE_PER_SIDE)
            reason = "target"
        else:
            continue
        net_return = _trade_return(direction, entry, exit_price)
        risk_fraction = abs(entry - stop) / entry + (2 * FEE_PER_SIDE)
        return {
            "status": "closed",
            "direction": direction,
            "signal_time": candles.index[entry_index - 1].isoformat(),
            "entry_time": candles.index[entry_index].isoformat(),
            "exit_time": candles.index[cursor].isoformat(),
            "entry": round(entry, 2),
            "exit": round(exit_price, 2),
            "stop": round(stop, 2),
            "target": round(target, 2),
            "range_low": round(range_state["low"], 2),
            "range_high": round(range_state["high"], 2),
            "reason": reason,
            "return_pct": round(net_return * 100, 4),
            "r_multiple": round(net_return / risk_fraction, 4) if risk_fraction else 0.0,
        }, cursor, True

    if final_required_index <= len(candles) - 1:
        raw_exit = float(candles.iloc[final_required_index]["close"])
        exit_price = raw_exit * (1 - SLIPPAGE_PER_SIDE if direction == "long" else 1 + SLIPPAGE_PER_SIDE)
        net_return = _trade_return(direction, entry, exit_price)
        risk_fraction = abs(entry - stop) / entry + (2 * FEE_PER_SIDE)
        return {
            "status": "closed",
            "direction": direction,
            "signal_time": candles.index[entry_index - 1].isoformat(),
            "entry_time": candles.index[entry_index].isoformat(),
            "exit_time": candles.index[final_required_index].isoformat(),
            "entry": round(entry, 2),
            "exit": round(exit_price, 2),
            "stop": round(stop, 2),
            "target": round(target, 2),
            "range_low": round(range_state["low"], 2),
            "range_high": round(range_state["high"], 2),
            "reason": "time",
            "return_pct": round(net_return * 100, 4),
            "r_multiple": round(net_return / risk_fraction, 4) if risk_fraction else 0.0,
        }, final_required_index, True

    return {
        "status": "open",
        "direction": direction,
        "signal_time": candles.index[entry_index - 1].isoformat(),
        "entry_time": candles.index[entry_index].isoformat(),
        "entry": round(entry, 2),
        "stop": round(stop, 2),
        "target": round(target, 2),
        "range_low": round(range_state["low"], 2),
        "range_high": round(range_state["high"], 2),
        "bars_observed": last_observed_index - entry_index + 1,
        "max_hold_bars": max_hold_bars,
    }, last_observed_index, False


def forward_paper_track(candles: pd.DataFrame, spec: RangeSpec, start: pd.Timestamp) -> dict:
    """Replay only evidence that arrived after the frozen forward boundary."""
    candles = candles.sort_index()
    atr = _true_range(candles).rolling(14).mean()
    cursor = max(spec.lookback_bars, 15, int(candles.index.searchsorted(start)))
    closed: list[dict] = []
    open_trade = None
    pending_entry = None
    while cursor < len(candles):
        state = _range_at(candles, cursor, spec, atr)
        direction = _signal(candles.iloc[cursor], state) if state else None
        if not direction:
            cursor += 1
            continue
        if cursor + 1 >= len(candles):
            pending_entry = {
                "status": "pending_entry",
                "direction": direction,
                "signal_time": candles.index[cursor].isoformat(),
                "range_low": round(state["low"], 2),
                "range_high": round(state["high"], 2),
                "stop_reference_atr": round(state["atr"], 2),
                "target": round(state["midpoint"], 2),
            }
            break
        trade, exit_index, resolved = _paper_trade(
            candles, cursor + 1, direction, state, spec.lookback_bars
        )
        if not trade:
            cursor += 1
            continue
        if not resolved:
            open_trade = trade
            break
        closed.append(trade)
        cursor = exit_index + 1
    return {
        "metrics": _metrics(closed),
        "closed_trades": closed,
        "open_trade": open_trade,
        "pending_entry": pending_entry,
    }


def _metrics(trades: list[dict]) -> dict:
    if not trades:
        return {
            "trades": 0,
            "win_rate_pct": None,
            "expectancy_pct": None,
            "profit_factor": None,
            "profit_factor_infinite": False,
            "total_return_pct": None,
            "max_drawdown_pct": None,
        }
    returns = [trade["return_pct"] / 100 for trade in trades]
    wins = [value for value in returns if value > 0]
    losses = [value for value in returns if value <= 0]
    equity = 1.0
    peak = 1.0
    max_drawdown = 0.0
    for value in returns:
        equity *= 1 + value
        peak = max(peak, equity)
        max_drawdown = max(max_drawdown, (peak - equity) / peak)
    gross_profit = sum(wins)
    gross_loss = abs(sum(losses))
    return {
        "trades": len(trades),
        "win_rate_pct": round(100 * len(wins) / len(trades), 2),
        "expectancy_pct": round(100 * sum(returns) / len(returns), 4),
        "profit_factor": round(gross_profit / gross_loss, 3) if gross_loss else None,
        "profit_factor_infinite": bool(wins and not gross_loss),
        "total_return_pct": round((equity - 1) * 100, 2),
        "max_drawdown_pct": round(max_drawdown * 100, 2),
    }


def build_range_lab(
    candles: pd.DataFrame,
    specs: tuple[RangeSpec, ...] = SPECS,
    *,
    train_end: pd.Timestamp = TRAIN_END,
    validation_end: pd.Timestamp = VALIDATION_END,
    holdout_end: pd.Timestamp = HOLDOUT_END,
) -> dict:
    if len(candles) < 1_000:
        raise ValueError("At least 1,000 candles are required for a chronological holdout")
    candles = candles.sort_index()
    if not (candles.index[0] < train_end < validation_end < holdout_end):
        raise ValueError("Fixed chronological boundaries must fall inside the available history")
    if candles.index[-1] + pd.Timedelta(hours=4) < holdout_end:
        raise ValueError("History does not reach the fixed holdout end")
    periods = {
        "train": (candles.index[0], train_end),
        "validation": (train_end, validation_end),
        "holdout": (validation_end, holdout_end),
    }

    candidates = []
    for spec in specs:
        trades_by_period = {
            name: backtest_spec(candles, spec, start=start, end=end)
            for name, (start, end) in periods.items()
        }
        runner_trades_by_period = {
            name: backtest_runner_cohort(
                candles, spec, trades_by_period[name], end=end
            )
            for name, (_start, end) in periods.items()
        }
        for name in periods:
            baseline_entries = [
                (trade.get("direction"), trade.get("signal_time"), trade["entry_time"])
                for trade in trades_by_period[name]
            ]
            runner_entries = [
                (trade.get("direction"), trade.get("signal_time"), trade["entry_time"])
                for trade in runner_trades_by_period[name]
            ]
            if runner_entries != baseline_entries:
                raise RuntimeError(f"Runner changed the paired {name} entry cohort")
        trades = [trade for name in periods for trade in trades_by_period[name]]
        baseline_metrics = {name: _metrics(trades_by_period[name]) for name in periods}
        runner_metrics = {name: _metrics(runner_trades_by_period[name]) for name in periods}
        deltas = {}
        for name in periods:
            baseline_expectancy = baseline_metrics[name]["expectancy_pct"]
            runner_expectancy = runner_metrics[name]["expectancy_pct"]
            deltas[name] = {
                "trades": runner_metrics[name]["trades"] - baseline_metrics[name]["trades"],
                "expectancy_pct": (
                    round(runner_expectancy - baseline_expectancy, 4)
                    if runner_expectancy is not None and baseline_expectancy is not None
                    else None
                ),
                "max_drawdown_pct": (
                    round(
                        runner_metrics[name]["max_drawdown_pct"]
                        - baseline_metrics[name]["max_drawdown_pct"],
                        2,
                    )
                    if runner_metrics[name]["max_drawdown_pct"] is not None
                    and baseline_metrics[name]["max_drawdown_pct"] is not None
                    else None
                ),
            }
        result = {
            "spec": asdict(spec),
            "latest_range": _latest_range_snapshot(candles, spec),
            "metrics": baseline_metrics,
            "recent_trades": trades[-12:],
            "exit_comparison": {
                "baseline": baseline_metrics,
                "runner": runner_metrics,
                "runner_minus_baseline": deltas,
            },
            "forward_paper": forward_paper_track(candles, spec, holdout_end),
        }
        candidates.append(result)

    def validation_score(candidate: dict) -> tuple[float, float, int]:
        metrics = candidate["metrics"]["validation"]
        expectancy = metrics["expectancy_pct"] if metrics["expectancy_pct"] is not None else -inf
        profit_factor = (
            inf
            if metrics["profit_factor_infinite"]
            else metrics["profit_factor"] if metrics["profit_factor"] is not None else -inf
        )
        return expectancy, profit_factor, metrics["trades"]

    def validation_eligible(candidate: dict) -> bool:
        validation = candidate["metrics"]["validation"]
        return bool(
            validation["trades"] >= 20
            and validation["expectancy_pct"] is not None
            and validation["expectancy_pct"] > 0
            and (
                validation["profit_factor_infinite"]
                or (validation["profit_factor"] is not None and validation["profit_factor"] > 1)
            )
        )

    validation_leader = max(candidates, key=validation_score)
    eligible_candidates = [candidate for candidate in candidates if validation_eligible(candidate)]
    selected = max(eligible_candidates, key=validation_score) if eligible_candidates else None
    holdout = selected["metrics"]["holdout"] if selected else None
    passed = bool(
        holdout
        and holdout["trades"] >= 30
        and holdout["expectancy_pct"] is not None
        and holdout["expectancy_pct"] > 0
        and (
            holdout["profit_factor_infinite"]
            or (holdout["profit_factor"] is not None and holdout["profit_factor"] > 1)
        )
    )
    data_through = candles.index[-1] + pd.Timedelta(hours=4)
    return {
        # Candle-derived rather than wall-clock-derived so a refresh with no
        # new completed bar does not create a meaningless commit/deployment.
        "generated_at": data_through.isoformat(),
        "current_range_data_through": data_through.isoformat(),
        "research_metrics_through": holdout_end.isoformat(),
        "instrument": "Kraken PF_XBTUSD perpetual futures",
        "timeframe": "4h",
        "history": {
            "start": candles.index[0].isoformat(),
            "end": candles.index[-1].isoformat(),
            "candles": len(candles),
        },
        "split": {
            "train_end": train_end.isoformat(),
            "validation_end": validation_end.isoformat(),
            "holdout_end": holdout_end.isoformat(),
            "selection_rule": "fixed calendar partitions; highest validation expectancy among candidates passing the validation gate; holdout never used to choose",
        },
        "costs": {
            "fee_per_side_pct": FEE_PER_SIDE * 100,
            "slippage_per_side_pct": SLIPPAGE_PER_SIDE * 100,
        },
        "rules": {
            "entry": "completed-candle rejection at a previously formed range edge; enter next bar open",
            "exit": "range midpoint, stop beyond boundary by 0.35 ATR, or time exit",
            "intrabar": "stop wins if stop and target occur in the same candle",
            "minimum_edge_touches": MIN_EDGE_TOUCHES,
        },
        "exit_experiment": {
            "version": EXIT_EXPERIMENT_VERSION,
            "frozen_at": "2026-11-06",
            "status": "exploratory historical sensitivity; not an untouched holdout or selection rule",
            "baseline": "100% at midpoint",
            "runner": "50% at midpoint; 50% at opposite boundary; original stop unchanged",
            "cohort": "paired to the baseline's exact signal, direction, and next-bar entry; runner observations may overlap",
            "costs": "same fee and slippage per side, weighted by leg size",
            "intrabar": "stop wins for all remaining size when stop and an unfilled target share a candle",
        },
        "forward_tracking": {
            "version": PAPER_TRACKING_VERSION,
            "frozen_at": holdout_end.isoformat(),
            "data_through": data_through.isoformat(),
            "mode": "candidate-level observation only; no real orders and no combined portfolio",
            "candidate_count": len(candidates),
            "validated_candidate_key": selected["spec"]["key"] if passed else None,
        },
        "validation_leader_key": validation_leader["spec"]["key"],
        "selected_key": selected["spec"]["key"] if selected else None,
        "holdout_passed": passed,
        "verdict": (
            "Positive holdout expectancy after modeled costs. This is evidence worth monitoring, not a promise of profit."
            if passed
            else "No strategy earned a validated-edge label. Keep this in research mode; do not treat it as a signal service."
        ),
        "candidates": candidates,
    }
