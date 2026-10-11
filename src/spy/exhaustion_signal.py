"""Detects the setup described by the user: on Heikin-Ashi candles, during
10:00-12:00 ET, a run of TREND_LOOKBACK same-direction candles followed by
a doji/exhaustion candle whose wick (on the side the trend was moving
toward) is bigger than the full range of at least one of the trend candles
that preceded it.

Two readings of the user's rule were genuinely ambiguous and are encoded
here as explicit, tunable choices rather than silently guessed:

1. "Doji wicks larger than at least one of the candles in the preceding
   trend" - read as: the relevant wick's price length exceeds the full
   high-low range of at least one trend candle (not just its body). The
   relevant wick is the one on the exhaustion side: upper wick after an
   uptrend, lower wick after a downtrend - matching "particular attention
   to the wick structure relative to the preceding trend."
2. "Watching 4 timeframes" - the user didn't say whether all 4 must agree,
   a majority, or just one. This module doesn't decide that: it tags every
   signal with how many of the 4 timeframes (10m/15m/20m/30m) confirm it at
   that moment, so the backtest can report results at every confluence
   threshold (>=1, >=2, >=3, all 4) side by side instead of baking in a
   guess.
"""

from dataclasses import dataclass, field

import pandas as pd

DOJI_BODY_MAX_PCT = 0.30  # candidate candle's body must be <= this fraction of its own range
TREND_LOOKBACK = 4        # how many same-direction HA candles must precede the candidate
# TREND_LOOKBACK was 3 until a parameter sweep (src/spy/sweep.py, 2026-10-11) against the
# real ~2-year Alpaca sample found trend=4/doji<=0.30 the best-supported cell in a 4x6 grid
# (150 resolved trades, +1.43% avg premium return vs. -0.05% at trend=3) - see README "Next
# up" for the full table and the one-cell-of-24 overfitting caveat that comes with it.
SESSION_START = "10:00"
SESSION_END = "12:00"
SIGNAL_CLUSTER_MINUTES = 15  # collapse near-simultaneous multi-TF triggers into one signal


@dataclass
class Signal:
    time: pd.Timestamp       # close time of the triggering candle, UTC
    direction: str           # "call" (downtrend exhaustion -> expect reversal up) or "put"
    n_confirmed: int         # how many of the 4 timeframes agree at this moment
    confirmed_timeframes: list[int] = field(default_factory=list)


def _bar_direction(row) -> int:
    if row["ha_close"] > row["ha_open"]:
        return 1
    if row["ha_close"] < row["ha_open"]:
        return -1
    return 0


def _qualifies(frame: pd.DataFrame) -> pd.Series:
    """Boolean Series, True on bars that are a qualifying exhaustion candle
    given the TREND_LOOKBACK bars immediately before them."""
    direction = frame.apply(_bar_direction, axis=1)
    body = (frame["ha_close"] - frame["ha_open"]).abs()
    rng = frame["ha_high"] - frame["ha_low"]
    body_pct = (body / rng.replace(0, pd.NA)).fillna(1.0)
    is_doji = body_pct <= DOJI_BODY_MAX_PCT

    upper_wick = frame["ha_high"] - frame[["ha_open", "ha_close"]].max(axis=1)
    lower_wick = frame[["ha_open", "ha_close"]].min(axis=1) - frame["ha_low"]

    result = pd.Series(False, index=frame.index)
    for i in range(TREND_LOOKBACK, len(frame)):
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
            result.iloc[i] = True

    return result


def _qualifying_direction(frame: pd.DataFrame, qualifies: pd.Series) -> pd.Series:
    """'call' if the preceding trend was down (exhaustion -> expect reversal
    up), 'put' if the preceding trend was up."""
    direction = frame.apply(_bar_direction, axis=1)
    out = pd.Series(index=frame.index, dtype=object)
    for i in range(TREND_LOOKBACK, len(frame)):
        if qualifies.iloc[i]:
            trend_dir = direction.iloc[i - TREND_LOOKBACK]
            out.iloc[i] = "call" if trend_dir == -1 else "put"
    return out


def _in_session(index: pd.DatetimeIndex) -> pd.Series:
    local = index.tz_convert("America/New_York")
    times = local.strftime("%H:%M")
    return pd.Series((times >= SESSION_START) & (times <= SESSION_END), index=index)


def find_signals(timeframes: dict[int, pd.DataFrame]) -> list[Signal]:
    """timeframes: {minutes: DataFrame} as returned by
    heikin_ashi.build_timeframes(). Returns one Signal per distinct
    exhaustion event, each tagged with how many timeframes confirmed it."""
    qualifies_by_tf: dict[int, pd.Series] = {}
    direction_by_tf: dict[int, pd.Series] = {}
    for minutes, frame in timeframes.items():
        q = _qualifies(frame) & _in_session(frame.index)
        qualifies_by_tf[minutes] = q
        direction_by_tf[minutes] = _qualifying_direction(frame, q)

    candidate_times = sorted(
        {
            ts
            for minutes, q in qualifies_by_tf.items()
            for ts in q.index[q]
        }
    )

    raw_signals: list[Signal] = []
    for t in candidate_times:
        votes: dict[str, list[int]] = {"call": [], "put": []}
        for minutes, frame in timeframes.items():
            closed = frame.index[frame.index <= t]
            if len(closed) == 0:
                continue
            latest = closed[-1]
            if qualifies_by_tf[minutes].loc[latest]:
                votes[direction_by_tf[minutes].loc[latest]].append(minutes)

        direction = "call" if len(votes["call"]) >= len(votes["put"]) else "put"
        confirmed = votes[direction]
        if confirmed:
            raw_signals.append(
                Signal(time=t, direction=direction, n_confirmed=len(confirmed), confirmed_timeframes=confirmed)
            )

    return _cluster_signals(raw_signals)


def _cluster_signals(signals: list[Signal]) -> list[Signal]:
    """Collapses signals within SIGNAL_CLUSTER_MINUTES of each other (same
    direction) into the single best-confirmed one - four timeframes closing
    their qualifying bar within a few minutes of each other is one trading
    decision, not four."""
    if not signals:
        return []
    signals = sorted(signals, key=lambda s: s.time)
    clustered: list[Signal] = [signals[0]]
    for sig in signals[1:]:
        last = clustered[-1]
        gap = (sig.time - last.time).total_seconds() / 60
        if gap <= SIGNAL_CLUSTER_MINUTES and sig.direction == last.direction:
            if sig.n_confirmed > last.n_confirmed:
                clustered[-1] = sig
        else:
            clustered.append(sig)
    return clustered
