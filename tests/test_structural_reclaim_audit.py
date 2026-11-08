from src.levels.structural_reclaim_audit import build_structural_reclaim_audit


def _regime(price=82_790.9, pivots=4, months=4, span=176, calculated="2026-11-07T06:49:25Z"):
    return {
        "quality": "established",
        "calculated_at_utc": calculated,
        "boundary": {
            "exact_price": price,
            "origin_date": "2026-05-06",
            "pivot_count": pivots,
            "distinct_months": months,
            "span_days": span,
        },
    }


def test_initial_established_boundary_is_recorded_without_alerting():
    audit = build_structural_reclaim_audit(_regime(), None, "2026-11-07T07:00:00Z")
    assert audit["status"] == "initialized"
    assert audit["current_since"] == "2026-11-07T06:49:25Z"
    assert audit["events"] == []
    assert audit["notification"]["should_notify"] is False


def test_unchanged_boundary_carries_since_and_prior_events():
    event = {"changed_at_utc": "2026-10-01T00:00:00Z", "new_exact_price": 82_790.9}
    previous = {
        "structural_reclaim": _regime(),
        "structural_reclaim_audit": {
            "current_since": "2026-10-01T00:00:00Z",
            "events": [event],
        },
    }
    audit = build_structural_reclaim_audit(_regime(), previous, "2026-11-08T07:00:00Z")
    assert audit["status"] == "unchanged"
    assert audit["current_since"] == "2026-10-01T00:00:00Z"
    assert audit["events"] == [event]
    assert audit["notification"]["should_notify"] is False


def test_changed_established_boundary_appends_auditable_alert_event():
    previous = {
        "structural_reclaim": _regime(price=82_000, pivots=4),
        "structural_reclaim_audit": {"events": []},
    }
    audit = build_structural_reclaim_audit(
        _regime(price=83_250, pivots=5),
        previous,
        "2026-11-08T07:00:00Z",
    )
    assert audit["status"] == "changed"
    assert audit["latest_change"]["old_exact_price"] == 82_000
    assert audit["latest_change"]["new_exact_price"] == 83_250
    assert "repeat-tested" in audit["latest_change"]["reason"]
    assert audit["notification"]["should_notify"] is True
    assert ":83250.00000000:" in audit["notification"]["fingerprint"]


def test_developing_candidate_never_replaces_or_alerts():
    developing = _regime(price=84_000)
    developing["quality"] = "developing"
    previous = {"structural_reclaim": _regime()}
    audit = build_structural_reclaim_audit(developing, previous, "2026-11-08T07:00:00Z")
    assert audit["status"] == "unavailable"
    assert audit["last_established"]["exact_price"] == 82_790.9
    assert audit["notification"]["should_notify"] is False


def test_established_change_after_developing_gap_uses_last_established_baseline():
    established_a = _regime(price=82_000)
    initialized = build_structural_reclaim_audit(established_a, None, "2026-11-07T07:00:00Z")
    developing = _regime(price=84_000)
    developing["quality"] = "developing"
    gap = build_structural_reclaim_audit(
        developing,
        {"structural_reclaim": established_a, "structural_reclaim_audit": initialized},
        "2026-11-08T07:00:00Z",
    )
    changed = build_structural_reclaim_audit(
        _regime(price=83_250, pivots=5),
        {"structural_reclaim": developing, "structural_reclaim_audit": gap},
        "2026-11-09T07:00:00Z",
    )
    assert changed["status"] == "changed"
    assert changed["latest_change"]["old_exact_price"] == 82_000
    assert changed["latest_change"]["new_exact_price"] == 83_250
    assert len(changed["events"]) == 1
    assert changed["notification"]["should_notify"] is True


def test_same_established_boundary_after_gap_remains_unchanged_without_alert():
    established_a = _regime(price=82_000)
    initialized = build_structural_reclaim_audit(established_a, None, "2026-11-07T07:00:00Z")
    developing = _regime(price=84_000)
    developing["quality"] = "developing"
    gap = build_structural_reclaim_audit(
        developing,
        {"structural_reclaim": established_a, "structural_reclaim_audit": initialized},
        "2026-11-08T07:00:00Z",
    )
    unchanged = build_structural_reclaim_audit(
        _regime(price=82_000),
        {"structural_reclaim": developing, "structural_reclaim_audit": gap},
        "2026-11-09T07:00:00Z",
    )
    assert unchanged["status"] == "unchanged"
    assert unchanged["current_since"] == "2026-11-07T06:49:25Z"
    assert unchanged["events"] == []
    assert unchanged["notification"]["should_notify"] is False
