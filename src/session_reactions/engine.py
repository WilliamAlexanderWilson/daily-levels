"""Pure market-open reaction calculations.

This module describes what happened after an open; it does not predict the
next move or turn an average reaction into a trade signal.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from math import isfinite
from statistics import median
from zoneinfo import ZoneInfo

import pandas as pd

HORIZONS_MINUTES = (15, 30, 60, 120)
MIN_RANKING_SAMPLES = 20


@dataclass(frozen=True)
class SessionOpen:
    key: str
    name: str
    default_rank: int
    timezone: str
    hour: int
    minute: int
    weekdays: tuple[int, ...] = (0, 1, 2, 3, 4)


SESSIONS = (
    SessionOpen("new-york", "New York", 1, "America/New_York", 9, 30),
    # CME Globex reopens Sunday-Thursday at 5 p.m. Chicago time.
    SessionOpen("cme-equity", "Chicago", 2, "America/Chicago", 17, 0, (0, 1, 2, 3, 6)),
    SessionOpen("london", "London", 3, "Europe/London", 8, 0),
    SessionOpen("tokyo", "Tokyo", 4, "Asia/Tokyo", 9, 0),
    SessionOpen("hong-kong", "Hong Kong", 5, "Asia/Hong_Kong", 9, 30),
    SessionOpen("xetra", "Frankfurt", 6, "Europe/Berlin", 9, 0),
    SessionOpen("sydney", "Sydney", 7, "Australia/Sydney", 10, 0),
)


def _round(value: float, places: int = 4) -> float:
    return round(float(value), places)


def candidate_opens(session: SessionOpen, start: pd.Timestamp, end: pd.Timestamp):
    zone = ZoneInfo(session.timezone)
    local_start = start.tz_convert(zone).date() - timedelta(days=1)
    local_end = end.tz_convert(zone).date() + timedelta(days=1)
    current = local_start
    while current <= local_end:
        if current.weekday() in session.weekdays:
            local = datetime.combine(current, time(session.hour, session.minute), tzinfo=zone)
            opened = pd.Timestamp(local).tz_convert("UTC")
            if start <= opened <= end:
                yield opened
        current += timedelta(days=1)


def complete_window(frame: pd.DataFrame, start: pd.Timestamp, minutes: int, interval_minutes: int):
    expected = minutes // interval_minutes
    if expected < 1 or minutes % interval_minutes:
        raise ValueError("horizons must be divisible by the candle interval")
    expected_index = pd.date_range(start, periods=expected, freq=f"{interval_minutes}min", tz="UTC")
    window = frame.reindex(expected_index)
    if window[["open", "high", "low", "close", "volume"]].isna().any().any():
        return None
    return window


def _summarize(values: list[float]) -> dict:
    if not values:
        return {"n": 0, "median_return_pct": None, "median_abs_move_pct": None, "up_rate_pct": None}
    return {
        "n": len(values),
        "median_return_pct": _round(median(values)),
        "median_abs_move_pct": _round(median(abs(value) for value in values)),
        "up_rate_pct": _round(100 * sum(value > 0 for value in values) / len(values), 1),
    }


def analyze_session(frame: pd.DataFrame, session: SessionOpen, interval_minutes: int) -> dict:
    returns = {minutes: [] for minutes in HORIZONS_MINUTES}
    volume_ratios: list[float] = []
    range_ratios: list[float] = []

    for opened in candidate_opens(session, frame.index.min(), frame.index.max()):
        entry = frame.reindex([opened])
        if entry[["open"]].isna().any().any():
            continue
        entry_price = float(entry.iloc[0]["open"])
        for horizon in HORIZONS_MINUTES:
            window = complete_window(frame, opened, horizon, interval_minutes)
            if window is not None:
                returns[horizon].append(100 * (float(window.iloc[-1]["close"]) / entry_price - 1))

        post = complete_window(frame, opened, 60, interval_minutes)
        pre = complete_window(frame, opened - pd.Timedelta(minutes=60), 60, interval_minutes)
        if post is None or pre is None:
            continue
        prior_volume = float(pre["volume"].sum())
        if prior_volume > 0:
            volume_ratios.append(float(post["volume"].sum()) / prior_volume)
        prior_range = float(pre["high"].max() - pre["low"].min())
        if prior_range > 0:
            range_ratios.append(float(post["high"].max() - post["low"].min()) / prior_range)

    horizons = {str(minutes): _summarize(returns[minutes]) for minutes in HORIZONS_MINUTES}
    n = horizons["60"]["n"]
    if n >= MIN_RANKING_SAMPLES:
        evidence_status = "measured"
    elif n >= 5:
        evidence_status = "limited"
    else:
        evidence_status = "insufficient"
    return {
        "key": session.key,
        "name": session.name,
        "default_rank": session.default_rank,
        "evidence_status": evidence_status,
        "horizons": horizons,
        "median_volume_ratio_60m": _round(median(volume_ratios)) if volume_ratios else None,
        "volume_ratio_n": len(volume_ratios),
        "median_range_expansion_60m": _round(median(range_ratios)) if range_ratios else None,
        "range_expansion_n": len(range_ratios),
    }


def build_reaction_payload(
    asset: str,
    candles: pd.DataFrame,
    interval_minutes: int,
    source_name: str,
    source_url: str,
    source_note: str,
) -> dict:
    required = {"open", "high", "low", "close", "volume"}
    if not required.issubset(candles.columns):
        raise ValueError(f"candles are missing {sorted(required - set(candles.columns))}")
    frame = candles.copy().sort_index()
    frame.index = pd.to_datetime(frame.index, utc=True)
    frame = frame[~frame.index.duplicated(keep="last")]
    if frame.empty:
        raise ValueError("candles cannot be empty")

    sessions = [analyze_session(frame, session, interval_minutes) for session in SESSIONS]
    eligible = [
        session for session in sessions
        if session["evidence_status"] == "measured"
        and session["horizons"]["60"]["median_abs_move_pct"] is not None
        and isfinite(session["horizons"]["60"]["median_abs_move_pct"])
    ]
    eligible.sort(key=lambda item: (-item["horizons"]["60"]["median_abs_move_pct"], item["default_rank"]))
    observed_rank: dict[str, int] = {}
    prior_value = None
    prior_rank = None
    for position, session in enumerate(eligible, 1):
        value = session["horizons"]["60"]["median_abs_move_pct"]
        rank = prior_rank if prior_value == value else position
        observed_rank[session["key"]] = rank
        prior_value = value
        prior_rank = rank
    for session in sessions:
        session["observed_rank"] = observed_rank.get(session["key"])

    now = pd.Timestamp.now(tz="UTC")
    return {
        "schema_version": 1,
        "asset": asset,
        "generated_at_utc": now.isoformat(),
        "coverage_start_utc": frame.index.min().isoformat(),
        "coverage_end_utc": frame.index.max().isoformat(),
        "candle_interval_minutes": interval_minutes,
        "source": {"name": source_name, "url": source_url, "note": source_note},
        "methodology": {
            "ranking_basis": "median absolute price move 60 minutes after the regular open",
            "minimum_samples_for_rank": MIN_RANKING_SAMPLES,
            "horizons_minutes": list(HORIZONS_MINUTES),
            "limitations": [
                "Descriptive historical reaction, not a prediction or trade signal.",
                "Regular weekdays are modeled; exchange holidays and unscheduled closures are not removed.",
                "Results describe this data source and lookback only and may not persist out of sample.",
            ],
        },
        "sessions": sessions,
    }
