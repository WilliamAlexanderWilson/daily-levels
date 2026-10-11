"""Detects a Heikin-Ashi exhaustion candle on the daily timeframe: a run of
TREND_LOOKBACK same-direction HA candles followed by a doji/exhaustion
candle whose rejection-side wick exceeds the full range of at least one of
the preceding trend candles. Same pattern definition as
src/spy/exhaustion_signal.py, but single-timeframe (daily only - there's no
SPY-style 10am-noon intraday session concept for BTC/ETH) and deliberately
NOT sharing code with src/spy/ - that module's own docstring explains why
SPY is kept fully independent from the crypto side, and the same reasoning
applies in reverse here.

This is purely descriptive, same as every other level on this site: it
reports that the pattern just formed and (via
src/backtest/exhaustion_pattern.py) what it has historically done -
never a buy/sell call. See the "Product philosophy" section of CLAUDE.md.
"""

from dataclasses import dataclass

import pandas as pd

TREND_LOOKBACK = 3        # how many same-direction daily HA candles must precede the candidate
DOJI_BODY_MAX_PCT = 0.30  # candidate candle's body must be <= this fraction of its own range
# Generic starting values, NOT tuned for BTC/ETH specifically. SPY's
# trend=4/doji<=0.30 (src/spy/exhaustion_signal.py) came from a parameter
# sweep against SPY's own options-expiry economics (+20%/-10% over a fixed
# 2-trading-day window) and has no reason to transfer to a daily-candle,
# no-expiry crypto context - these need their own sweep if ever revisited.


@dataclass
class ExhaustionDay:
    date: pd.Timestamp  # the qualifying (doji) candle's date
    idx: int             # its positional index into the candles_1d frame it was found in
    direction: str       # "bullish_reversal" (after a downtrend) or "bearish_reversal" (after an uptrend)


def to_heikin_ashi(df: pd.DataFrame) -> pd.DataFrame:
    """Standard Heikin-Ashi transform - duplicated from
    src/spy/heikin_ashi.py rather than imported, to keep the two modules
    independent (see that module's docstring)."""
    ha_close = (df["open"] + df["high"] + df["low"] + df["close"]) / 4

    ha_open = pd.Series(index=df.index, dtype=float)
    ha_open.iloc[0] = (df["open"].iloc[0] + df["close"].iloc[0]) / 2
    for i in range(1, len(df)):
        ha_open.iloc[i] = (ha_open.iloc[i - 1] + ha_close.iloc[i - 1]) / 2

    ha_high = pd.concat([df["high"], ha_open, ha_close], axis=1).max(axis=1)
    ha_low = pd.concat([df["low"], ha_open, ha_close], axis=1).min(axis=1)

    return pd.DataFrame(
        {"ha_open": ha_open, "ha_high": ha_high, "ha_low": ha_low, "ha_close": ha_close},
        index=df.index,
    )


def _bar_direction(row) -> int:
    if row["ha_close"] > row["ha_open"]:
        return 1
    if row["ha_close"] < row["ha_open"]:
        return -1
    return 0


def _find_in_ha_frame(ha: pd.DataFrame) -> list[ExhaustionDay]:
    """Core qualifying logic, operating directly on an already-Heikin-Ashi
    frame (ha_open/ha_high/ha_low/ha_close columns) - split out from
    find_exhaustion_days() so tests can inject hand-built HA rows directly,
    the same way src/spy/exhaustion_signal.py's tests do, instead of having
    to reverse-engineer real OHLC that produces a specific HA shape (HA
    open is a running recursive average of every prior candle, so it can't
    be hand-constructed from just a few real rows)."""
    direction = ha.apply(_bar_direction, axis=1)
    body = (ha["ha_close"] - ha["ha_open"]).abs()
    rng = ha["ha_high"] - ha["ha_low"]
    body_pct = (body / rng.replace(0, pd.NA)).fillna(1.0)
    is_doji = body_pct <= DOJI_BODY_MAX_PCT

    upper_wick = ha["ha_high"] - ha[["ha_open", "ha_close"]].max(axis=1)
    lower_wick = ha[["ha_open", "ha_close"]].min(axis=1) - ha["ha_low"]

    results: list[ExhaustionDay] = []
    for i in range(TREND_LOOKBACK, len(ha)):
        if not is_doji.iloc[i]:
            continue
        trend_window = direction.iloc[i - TREND_LOOKBACK : i]
        trend_dir = trend_window.iloc[0]
        if trend_dir == 0 or not (trend_window == trend_dir).all():
            continue  # not a clean run of same-direction candles

        # Uptrend exhaustion rejects at the top (long upper wick); downtrend
        # exhaustion rejects at the bottom (long lower wick).
        relevant_wick = upper_wick.iloc[i] if trend_dir == 1 else lower_wick.iloc[i]
        opposite_wick = lower_wick.iloc[i] if trend_dir == 1 else upper_wick.iloc[i]
        if relevant_wick <= opposite_wick:
            continue  # not pointing the expected reversal direction

        trend_ranges = rng.iloc[i - TREND_LOOKBACK : i]
        if (relevant_wick > trend_ranges).any():
            direction_label = "bearish_reversal" if trend_dir == 1 else "bullish_reversal"
            results.append(ExhaustionDay(date=ha.index[i], idx=i, direction=direction_label))

    return results


def find_exhaustion_days(candles_1d: pd.DataFrame) -> list[ExhaustionDay]:
    """Scans the full daily series for every historical occurrence. Each
    day's qualification only looks at its own fixed backward window
    (TREND_LOOKBACK candles), so - unlike the volume-profile/pivot levels -
    this never needs a day-by-day no-lookahead replay: running it once over
    the whole series is already point-in-time correct."""
    return _find_in_ha_frame(to_heikin_ashi(candles_1d))


def detect_latest(candles_1d: pd.DataFrame) -> dict | None:
    """Whether the most recent fully-closed daily candle (candles_1d's last
    row - src/fetch.py already drops the still-forming one) itself
    qualifies. None if it doesn't - this is "did it just form," not a
    historical list."""
    occurrences = find_exhaustion_days(candles_1d)
    if not occurrences:
        return None
    last = occurrences[-1]
    if last.idx != len(candles_1d) - 1:
        return None
    return {"date": last.date.date().isoformat(), "direction": last.direction}
