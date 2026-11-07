"""Prospective range-location observations at major market opens.

Rules are frozen in docs/RANGE-OPEN-FORWARD-TRACKER.md. This module records
descriptive outcomes only and never emits an entry or trade instruction.
"""

from __future__ import annotations

from copy import deepcopy
from datetime import timedelta

import pandas as pd

from src.session_reactions.engine import (
    HORIZONS_MINUTES,
    SESSIONS,
    SessionOpen,
    candidate_opens,
    complete_window,
)

SCHEMA_VERSION = 1
STUDY_VERSION = "range-open-forward-v1"
FORWARD_START_UTC = pd.Timestamp("2026-11-08T00:00:00Z")
RANGE_LOOKBACK_DAYS = 60
EDGE_FRACTION = 0.35
MIN_TOTAL_EDGE_EVENTS = 50
MIN_SIDE_EVENTS = 20
MIN_LOOKBACK_COMPLETENESS = 0.90


def _round(value: float, places: int = 4) -> float:
    return round(float(value), places)


def _prepare(candles: pd.DataFrame) -> pd.DataFrame:
    required = {"open", "high", "low", "close", "volume"}
    if not required.issubset(candles.columns):
        raise ValueError(f"candles are missing {sorted(required - set(candles.columns))}")
    frame = candles.copy().sort_index()
    frame.index = pd.to_datetime(frame.index, utc=True)
    frame = frame[~frame.index.duplicated(keep="last")]
    if frame.empty:
        raise ValueError("candles cannot be empty")
    return frame


def _expected_lookback_candles(asset: str, opened: pd.Timestamp, interval_minutes: int) -> int:
    if asset != "spy":
        return RANGE_LOOKBACK_DAYS * 24 * 60 // interval_minutes
    start_date = (opened - pd.Timedelta(days=RANGE_LOOKBACK_DAYS)).date()
    end_date = opened.date()
    weekdays = sum(
        1
        for offset in range((end_date - start_date).days)
        if (start_date + timedelta(days=offset)).weekday() < 5
    )
    # SPY's objective range uses regular-session 5-minute capacity as the
    # expected baseline. IEX can contain extended-hours prints as well.
    return weekdays * (390 // interval_minutes)


def _range_window(
    asset: str,
    frame: pd.DataFrame,
    opened: pd.Timestamp,
    interval_minutes: int,
) -> pd.DataFrame | None:
    start = opened - pd.Timedelta(days=RANGE_LOOKBACK_DAYS)
    window = frame[(frame.index >= start) & (frame.index < opened)]
    expected = _expected_lookback_candles(asset, opened, interval_minutes)
    if expected <= 0 or len(window) < expected * MIN_LOOKBACK_COMPLETENESS:
        return None
    return window


def _location(position: float) -> str:
    if position <= EDGE_FRACTION:
        return "lower-edge"
    if position >= 1 - EDGE_FRACTION:
        return "upper-edge"
    return "wait"


def _event_id(asset: str, session: SessionOpen, opened: pd.Timestamp) -> str:
    return f"{asset}|{session.key}|{opened.isoformat()}"


def _fill_outcomes(event: dict, frame: pd.DataFrame, interval_minutes: int) -> dict:
    result = deepcopy(event)
    if result.get("status") == "resolved":
        return result
    opened = pd.Timestamp(result["opened_at_utc"])
    entry = float(result["opening_price"])
    direction = 1 if result["location"] == "lower-edge" else -1 if result["location"] == "upper-edge" else 0
    horizons = {}
    for minutes in HORIZONS_MINUTES:
        window = complete_window(frame, opened, minutes, interval_minutes)
        if window is None:
            horizons[str(minutes)] = None
            continue
        raw_return = 100 * (float(window.iloc[-1]["close"]) / entry - 1)
        horizons[str(minutes)] = {
            "raw_return_pct": _round(raw_return),
            "direction_aligned_return_pct": _round(raw_return * direction) if direction else None,
        }
    result["horizons"] = horizons

    full = complete_window(frame, opened, 120, interval_minutes)
    if full is None:
        result["status"] = "pending"
        return result

    if direction:
        favorable = ((full["high"].max() / entry - 1) * 100) if direction > 0 else ((1 - full["low"].min() / entry) * 100)
        adverse = ((1 - full["low"].min() / entry) * 100) if direction > 0 else ((full["high"].max() / entry - 1) * 100)
        result["max_favorable_excursion_pct"] = _round(favorable)
        result["max_adverse_excursion_pct"] = _round(adverse)
        close_120 = float(full.iloc[-1]["close"])
        result["sweep_reclaim"] = bool(
            (direction > 0 and float(full["low"].min()) < result["range_low"] and close_120 > result["range_low"])
            or (direction < 0 and float(full["high"].max()) > result["range_high"] and close_120 < result["range_high"])
        )
    result["status"] = "resolved"
    result["resolved_at_utc"] = (opened + pd.Timedelta(minutes=120)).isoformat()
    return result


def _new_event(
    asset: str,
    frame: pd.DataFrame,
    session: SessionOpen,
    opened: pd.Timestamp,
    interval_minutes: int,
) -> dict | None:
    range_window = _range_window(asset, frame, opened, interval_minutes)
    opening = frame.reindex([opened])
    if range_window is None or opening[["open"]].isna().any().any():
        return None
    range_low = float(range_window["low"].min())
    range_high = float(range_window["high"].max())
    if not range_high > range_low:
        return None
    opening_price = float(opening.iloc[0]["open"])
    position = (opening_price - range_low) / (range_high - range_low)
    event = {
        "id": _event_id(asset, session, opened),
        "session_key": session.key,
        "session_name": session.name,
        "opened_at_utc": opened.isoformat(),
        "range_start_utc": (opened - pd.Timedelta(days=RANGE_LOOKBACK_DAYS)).isoformat(),
        "range_low": _round(range_low, 6),
        "range_high": _round(range_high, 6),
        "opening_price": _round(opening_price, 6),
        "range_position_pct": _round(position * 100, 2),
        "location": _location(position),
        "status": "pending",
        "horizons": {str(minutes): None for minutes in HORIZONS_MINUTES},
        "max_favorable_excursion_pct": None,
        "max_adverse_excursion_pct": None,
        "sweep_reclaim": None,
        "resolved_at_utc": None,
    }
    return _fill_outcomes(event, frame, interval_minutes)


def summarize_events(events: list[dict]) -> dict:
    resolved_edges = [event for event in events if event["location"] != "wait" and event["status"] == "resolved"]
    lower = [event for event in resolved_edges if event["location"] == "lower-edge"]
    upper = [event for event in resolved_edges if event["location"] == "upper-edge"]
    qualified = len(resolved_edges) >= MIN_TOTAL_EDGE_EVENTS and len(lower) >= MIN_SIDE_EVENTS and len(upper) >= MIN_SIDE_EVENTS
    aligned_60 = [
        event["horizons"]["60"]["direction_aligned_return_pct"]
        for event in resolved_edges
        if event.get("horizons", {}).get("60") is not None
    ]
    return {
        "total_events": len(events),
        "wait_events": sum(event["location"] == "wait" for event in events),
        "pending_events": sum(event["status"] == "pending" for event in events),
        "resolved_edge_events": len(resolved_edges),
        "resolved_lower_edge_events": len(lower),
        "resolved_upper_edge_events": len(upper),
        "evidence_gate_passed": qualified,
        "positive_directional_60m_rate_pct": _round(100 * sum(value > 0 for value in aligned_60) / len(aligned_60), 1)
        if qualified and aligned_60
        else None,
    }


def update_forward_payload(
    asset: str,
    candles: pd.DataFrame,
    interval_minutes: int,
    source: dict,
    existing: dict | None = None,
    *,
    forward_start: pd.Timestamp = FORWARD_START_UTC,
    sessions: tuple[SessionOpen, ...] = SESSIONS,
    generated_at: pd.Timestamp | None = None,
) -> dict:
    frame = _prepare(candles)
    start = pd.Timestamp(forward_start)
    if start.tzinfo is None:
        start = start.tz_localize("UTC")
    else:
        start = start.tz_convert("UTC")
    prior_events = {
        event["id"]: deepcopy(event)
        for event in (existing or {}).get("events", [])
        if event.get("id")
    }
    for event_id, event in list(prior_events.items()):
        prior_events[event_id] = _fill_outcomes(event, frame, interval_minutes)

    candidate_start = max(start, frame.index.min() + pd.Timedelta(days=RANGE_LOOKBACK_DAYS))
    for session in sessions:
        for opened in candidate_opens(session, candidate_start, frame.index.max()):
            event_id = _event_id(asset, session, opened)
            if event_id in prior_events:
                continue
            event = _new_event(asset, frame, session, opened, interval_minutes)
            if event is not None:
                prior_events[event_id] = event

    events = sorted(prior_events.values(), key=lambda event: (event["opened_at_utc"], event["session_key"]))
    now = generated_at or pd.Timestamp.now(tz="UTC")
    return {
        "schema_version": SCHEMA_VERSION,
        "study_version": STUDY_VERSION,
        "asset": asset,
        "generated_at_utc": now.isoformat(),
        "forward_start_utc": start.isoformat(),
        "source": source,
        "methodology": {
            "range_lookback_calendar_days": RANGE_LOOKBACK_DAYS,
            "edge_fraction": EDGE_FRACTION,
            "horizons_minutes": list(HORIZONS_MINUTES),
            "minimum_total_edge_events": MIN_TOTAL_EDGE_EVENTS,
            "minimum_each_side_events": MIN_SIDE_EVENTS,
            "rules": "docs/RANGE-OPEN-FORWARD-TRACKER.md",
            "limitations": [
                "Forward descriptive evidence only; not a prediction, signal, or profitability claim.",
                "Version 1 does not remove exchange holidays, half-days, or emergency closures.",
                "Underlying price movement excludes options, leverage, fees, slippage, and executable fills.",
            ],
        },
        "summary": summarize_events(events),
        "events": events,
    }
