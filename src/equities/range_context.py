"""Deterministic range context for U.S. equities.

The channel is descriptive market context, not a tested entry signal. It uses
only completed regular U.S. sessions so the boundaries cannot drift during the
current session or accidentally incorporate after-hours prints.
"""

from __future__ import annotations

import pandas as pd

EASTERN = "America/New_York"
LOOKBACK_SESSIONS = 20
EDGE_FRACTION = 0.15


def _regular_session_bars(frame: pd.DataFrame) -> pd.DataFrame:
    if frame.empty:
        return frame.copy()
    local = frame.copy()
    if local.index.tz is None:
        raise ValueError("equity range input must have a timezone-aware index")
    local.index = local.index.tz_convert(EASTERN)
    minutes = local.index.hour * 60 + local.index.minute
    return local[(minutes >= 9 * 60 + 30) & (minutes < 16 * 60)]


def completed_session_ohlc(frame: pd.DataFrame, generated_at: pd.Timestamp) -> pd.DataFrame:
    """Aggregate regular-session bars and exclude the unfinished current day."""
    regular = _regular_session_bars(frame)
    if regular.empty:
        return pd.DataFrame(columns=["open", "high", "low", "close", "volume"])

    now = pd.Timestamp(generated_at)
    if now.tzinfo is None:
        raise ValueError("generated_at must be timezone-aware")
    now_et = now.tz_convert(EASTERN)
    today = now_et.date()

    rows = []
    for session_date, day in regular.groupby(regular.index.date):
        if session_date > today:
            continue
        if session_date == today and now_et.hour < 16:
            continue
        # Every included day—not just today—must span the regular session.
        # Paginated or interrupted historical fetches can end at noon and
        # otherwise look like a legitimate prior day. IEX can omit quiet
        # five-minute buckets, so check the session endpoints instead of
        # requiring exactly 78 rows.
        if (
            day.index.min().time() > pd.Timestamp("09:40").time()
            or day.index.max().time() < pd.Timestamp("15:50").time()
        ):
            continue
        rows.append(
            {
                "session": pd.Timestamp(session_date),
                "open": float(day["open"].iloc[0]),
                "high": float(day["high"].max()),
                "low": float(day["low"].min()),
                "close": float(day["close"].iloc[-1]),
                "volume": float(day["volume"].sum()),
            }
        )
    if not rows:
        return pd.DataFrame(columns=["open", "high", "low", "close", "volume"])
    return pd.DataFrame(rows).set_index("session").sort_index()


def build_range_context(
    frame: pd.DataFrame,
    price: float,
    generated_at: pd.Timestamp,
    lookback: int = LOOKBACK_SESSIONS,
    edge_fraction: float = EDGE_FRACTION,
) -> dict:
    """Return a reproducible prior-session channel and current location."""
    sessions = completed_session_ohlc(frame, generated_at)
    if len(sessions) < lookback:
        return {
            "available": False,
            "method": f"Prior {lookback} completed regular sessions",
            "reason": f"Need {lookback} completed sessions; found {len(sessions)}.",
            "is_signal": False,
        }

    window = sessions.tail(lookback)
    low = float(window["low"].min())
    high = float(window["high"].max())
    width = high - low
    if width <= 0:
        return {
            "available": False,
            "method": f"Prior {lookback} completed regular sessions",
            "reason": "The completed-session channel has no measurable width.",
            "is_signal": False,
        }

    midpoint = (high + low) / 2
    lower_edge_max = low + width * edge_fraction
    upper_edge_min = high - width * edge_fraction
    position_pct = (float(price) - low) / width * 100
    if price < low:
        state = "below_range"
    elif price <= lower_edge_max:
        state = "lower_edge"
    elif price < upper_edge_min:
        state = "middle"
    elif price <= high:
        state = "upper_edge"
    else:
        state = "above_range"

    return {
        "available": True,
        "method": f"Prior {lookback} completed regular sessions",
        "lookback_sessions": lookback,
        "edge_fraction": edge_fraction,
        "window_start": window.index[0].date().isoformat(),
        "window_end": window.index[-1].date().isoformat(),
        "high": high,
        "upper_edge_min": upper_edge_min,
        "midpoint": midpoint,
        "lower_edge_max": lower_edge_max,
        "low": low,
        "width": width,
        "width_pct": width / midpoint * 100,
        "position_pct": position_pct,
        "state": state,
        "is_signal": False,
        "session_scope": "U.S. regular session, 9:30 AM–4:00 PM New York time",
        "source_limit": "Alpaca free IEX feed; one exchange, not consolidated SIP",
    }
