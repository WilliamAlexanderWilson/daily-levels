"""Build an append-only audit summary for the established BTC reclaim.

Only an established boundary can enter this record. Acceptance changes are
deliberately excluded: the alert is about the structural level moving, not
ordinary price noise around an unchanged level.
"""

from __future__ import annotations

from math import isclose


METHOD_VERSION = "structural-reclaim-audit-v1"
MAX_EVENTS = 8


def _established(regime: dict | None) -> dict | None:
    if not isinstance(regime, dict) or regime.get("quality") != "established":
        return None
    boundary = regime.get("boundary")
    if not isinstance(boundary, dict):
        return None
    try:
        exact_price = float(boundary["exact_price"])
    except (KeyError, TypeError, ValueError):
        return None
    if exact_price <= 0:
        return None
    return boundary


def _reason(previous: dict, current: dict) -> str:
    if int(current.get("pivot_count", 0)) > int(previous.get("pivot_count", 0)):
        return "A more repeat-tested established pivot cluster won the frozen ranking rule."
    if int(current.get("distinct_months", 0)) > int(previous.get("distinct_months", 0)):
        return "A cross-month established pivot cluster replaced the prior boundary."
    if int(current.get("span_days", 0)) > int(previous.get("span_days", 0)):
        return "A more durable established pivot cluster replaced the prior boundary."
    return "A different established pivot cluster won the frozen pivots, months, span, then recency ranking."


def _record(regime: dict, boundary: dict) -> dict:
    return {
        "exact_price": float(boundary["exact_price"]),
        "origin_date": boundary.get("origin_date"),
        "pivot_count": int(boundary.get("pivot_count", 0)),
        "distinct_months": int(boundary.get("distinct_months", 0)),
        "span_days": int(boundary.get("span_days", 0)),
        "calculated_at_utc": regime.get("calculated_at_utc"),
    }


def _stored_established(previous_audit: dict) -> dict | None:
    stored = previous_audit.get("last_established")
    if not isinstance(stored, dict):
        return None
    try:
        if float(stored["exact_price"]) <= 0:
            return None
    except (KeyError, TypeError, ValueError):
        return None
    return stored


def build_structural_reclaim_audit(
    current_regime: dict | None,
    previous_snapshot: dict | None,
    generated_at_utc: str,
) -> dict:
    """Compare established boundaries and preserve the latest change events."""
    current = _established(current_regime)
    previous_regime = previous_snapshot.get("structural_reclaim") if previous_snapshot else None
    previous = _established(previous_regime)
    previous_audit = previous_snapshot.get("structural_reclaim_audit", {}) if previous_snapshot else {}
    stored_established = _stored_established(previous_audit)
    baseline = previous or stored_established
    prior_events = previous_audit.get("events", [])
    events = [event for event in prior_events if isinstance(event, dict)][:MAX_EVENTS]

    if current is None:
        baseline_record = _record(previous_regime, previous) if previous is not None else stored_established
        return {
            "method_version": METHOD_VERSION,
            "status": "unavailable",
            "current_since": previous_audit.get("current_since"),
            "last_established": baseline_record,
            "latest_change": events[0] if events else None,
            "events": events,
            "notification": {"should_notify": False, "fingerprint": None},
            "reason": "No established structural boundary was available in this calculation.",
        }

    current_price = float(current["exact_price"])
    current_record = _record(current_regime, current)
    if baseline is None:
        current_since = current_regime.get("calculated_at_utc", generated_at_utc)
        return {
            "method_version": METHOD_VERSION,
            "status": "initialized",
            "current_since": current_since,
            "last_established": current_record,
            "latest_change": events[0] if events else None,
            "events": events,
            "notification": {"should_notify": False, "fingerprint": None},
            "reason": "First established boundary recorded; initialization does not trigger an alert.",
        }

    previous_price = float(baseline["exact_price"])
    if isclose(current_price, previous_price, rel_tol=0.0, abs_tol=1e-9):
        current_since = (
            previous_audit.get("current_since")
            or previous_regime.get("calculated_at_utc")
            or generated_at_utc
        )
        return {
            "method_version": METHOD_VERSION,
            "status": "unchanged",
            "current_since": current_since,
            "last_established": current_record,
            "latest_change": events[0] if events else None,
            "events": events,
            "notification": {"should_notify": False, "fingerprint": None},
            "reason": "The same established pivot cluster remains selected.",
        }

    event = {
        "changed_at_utc": generated_at_utc,
        "old_exact_price": previous_price,
        "new_exact_price": current_price,
        "old_origin_date": baseline.get("origin_date"),
        "new_origin_date": current.get("origin_date"),
        "new_pivot_count": int(current.get("pivot_count", 0)),
        "new_distinct_months": int(current.get("distinct_months", 0)),
        "reason": _reason(baseline, current),
    }
    fingerprint = f"{METHOD_VERSION}:{current_price:.8f}:{generated_at_utc}"
    events = [event, *events][:MAX_EVENTS]
    return {
        "method_version": METHOD_VERSION,
        "status": "changed",
        "current_since": generated_at_utc,
        "last_established": current_record,
        "latest_change": event,
        "events": events,
        "notification": {
            "should_notify": True,
            "fingerprint": fingerprint,
            "title": "BTC established structural level changed",
            "detail": f"${previous_price:,.2f} to ${current_price:,.2f}. {event['reason']}",
        },
        "reason": event["reason"],
    }
