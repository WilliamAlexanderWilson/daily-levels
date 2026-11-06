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
    return gross - (2 * FEE_PER_SIDE)


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
    end_index = min(len(candles) - 1, entry_index + max_hold_bars)
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


def backtest_spec(candles: pd.DataFrame, spec: RangeSpec) -> list[dict]:
    candles = candles.sort_index()
    atr = _true_range(candles).rolling(14).mean()
    trades: list[dict] = []
    cursor = max(spec.lookback_bars, 15)
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


def _metrics(trades: list[dict]) -> dict:
    if not trades:
        return {
            "trades": 0,
            "win_rate_pct": None,
            "expectancy_pct": None,
            "profit_factor": None,
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
        "total_return_pct": round((equity - 1) * 100, 2),
        "max_drawdown_pct": round(max_drawdown * 100, 2),
    }


def _split_trades(trades: list[dict], start: pd.Timestamp, end: pd.Timestamp) -> list[dict]:
    # A validation trade that exits in the holdout has consumed holdout prices
    # and cannot be used for model selection. Keep both ends of every trade
    # inside one chronological partition; this is an explicit boundary embargo.
    return [
        trade
        for trade in trades
        if start <= pd.Timestamp(trade["entry_time"]) < end
        and pd.Timestamp(trade["exit_time"]) < end
    ]


def build_range_lab(candles: pd.DataFrame, specs: tuple[RangeSpec, ...] = SPECS) -> dict:
    if len(candles) < 1_000:
        raise ValueError("At least 1,000 candles are required for a chronological holdout")
    candles = candles.sort_index()
    train_end = candles.index[int(len(candles) * 0.60)]
    validation_end = candles.index[int(len(candles) * 0.80)]
    final_end = candles.index[-1] + pd.Timedelta(hours=4)
    periods = {
        "train": (candles.index[0], train_end),
        "validation": (train_end, validation_end),
        "holdout": (validation_end, final_end),
    }

    candidates = []
    for spec in specs:
        trades = backtest_spec(candles, spec)
        result = {
            "spec": asdict(spec),
            "latest_range": _latest_range_snapshot(candles, spec),
            "metrics": {
                name: _metrics(_split_trades(trades, start, end))
                for name, (start, end) in periods.items()
            },
            "recent_trades": trades[-12:],
        }
        candidates.append(result)

    def validation_score(candidate: dict) -> tuple[float, float, int]:
        metrics = candidate["metrics"]["validation"]
        expectancy = metrics["expectancy_pct"] if metrics["expectancy_pct"] is not None else -inf
        profit_factor = metrics["profit_factor"] if metrics["profit_factor"] is not None else -inf
        return expectancy, profit_factor, metrics["trades"]

    validation_leader = max(candidates, key=validation_score)
    validation = validation_leader["metrics"]["validation"]
    selected = validation_leader if bool(
        validation["trades"] >= 20
        and validation["expectancy_pct"] is not None
        and validation["expectancy_pct"] > 0
        and validation["profit_factor"] is not None
        and validation["profit_factor"] > 1
    ) else None
    holdout = selected["metrics"]["holdout"] if selected else None
    passed = bool(
        holdout
        and holdout["trades"] >= 30
        and holdout["expectancy_pct"] is not None
        and holdout["expectancy_pct"] > 0
        and holdout["profit_factor"] is not None
        and holdout["profit_factor"] > 1
    )
    return {
        "generated_at": pd.Timestamp.now(tz="UTC").isoformat(),
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
            "selection_rule": "highest validation expectancy after costs; holdout never used to choose",
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

