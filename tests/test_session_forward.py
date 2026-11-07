import pandas as pd

from src.session_reactions.engine import SessionOpen
from src.session_reactions.forward import summarize_events, update_forward_payload

OPENED = pd.Timestamp("2026-03-02T00:00:00Z")  # Monday
UTC_SESSION = (SessionOpen("utc-test", "UTC Test", 1, "UTC", 0, 0),)
SOURCE = {"name": "fixture", "url": "https://example.test", "note": "test only"}


def _candles(entry=110.0, after_bars=8):
    index = pd.date_range(
        OPENED - pd.Timedelta(days=60),
        OPENED + pd.Timedelta(minutes=15 * (after_bars - 1)),
        freq="15min",
        tz="UTC",
    )
    frame = pd.DataFrame(
        {"open": 150.0, "high": 151.0, "low": 149.0, "close": 150.0, "volume": 10.0},
        index=index,
    )
    frame.iloc[0, frame.columns.get_loc("low")] = 100.0
    frame.iloc[1, frame.columns.get_loc("high")] = 200.0
    frame.loc[OPENED, ["open", "high", "low", "close"]] = [entry, entry + 1, entry - 1, entry + 0.5]
    for offset in range(1, after_bars):
        timestamp = OPENED + pd.Timedelta(minutes=15 * offset)
        move = offset + 1 if entry < 150 else -(offset + 1)
        frame.loc[timestamp, ["open", "high", "low", "close"]] = [
            entry + move * 0.8,
            entry + move * 0.8 + 1,
            entry + move * 0.8 - 1,
            entry + move,
        ]
    return frame


def _payload(frame, existing=None):
    return update_forward_payload(
        "btc",
        frame,
        15,
        SOURCE,
        existing,
        forward_start=OPENED,
        sessions=UTC_SESSION,
        generated_at=OPENED + pd.Timedelta(hours=3),
    )


def test_creates_resolved_lower_edge_event_without_lookahead_in_range():
    frame = _candles(entry=110)
    frame.loc[OPENED, "high"] = 500.0  # the opening candle must not redefine its own prior range
    payload = _payload(frame)
    event = payload["events"][0]
    assert event["range_low"] == 100.0
    assert event["range_high"] == 200.0
    assert event["range_position_pct"] == 10.0
    assert event["location"] == "lower-edge"
    assert event["status"] == "resolved"
    assert event["horizons"]["60"]["raw_return_pct"] > 0
    assert event["horizons"]["60"]["direction_aligned_return_pct"] > 0
    assert payload["summary"]["evidence_gate_passed"] is False
    assert payload["summary"]["positive_directional_60m_rate_pct"] is None


def test_upper_edge_aligns_falling_price_as_positive_directional_reaction():
    event = _payload(_candles(entry=190))["events"][0]
    assert event["location"] == "upper-edge"
    assert event["horizons"]["60"]["raw_return_pct"] < 0
    assert event["horizons"]["60"]["direction_aligned_return_pct"] > 0


def test_mid_range_open_is_preserved_as_wait_not_hidden():
    payload = _payload(_candles(entry=150))
    event = payload["events"][0]
    assert event["location"] == "wait"
    assert event["horizons"]["60"]["direction_aligned_return_pct"] is None
    assert payload["summary"]["wait_events"] == 1


def test_missing_open_or_incomplete_lookback_never_manufactures_event():
    missing_open = _candles().drop(OPENED)
    assert _payload(missing_open)["events"] == []
    incomplete = _candles().drop(_candles().index[:600])
    assert _payload(incomplete)["events"] == []


def test_pending_event_resolves_later_without_changing_frozen_inputs():
    pending_payload = _payload(_candles(entry=110, after_bars=4))
    pending = pending_payload["events"][0]
    assert pending["status"] == "pending"
    recorded_15m = pending["horizons"]["15"]
    recorded_60m = pending["horizons"]["60"]
    later_frame = _candles(entry=110, after_bars=8)
    later_frame.iloc[0, later_frame.columns.get_loc("low")] = 50.0
    later_frame.loc[OPENED, "close"] = 199.0
    resolved = _payload(later_frame, pending_payload)["events"][0]
    assert resolved["status"] == "resolved"
    assert resolved["range_low"] == 100.0
    assert resolved["opening_price"] == 110.0
    assert resolved["horizons"]["15"] == recorded_15m
    assert resolved["horizons"]["60"] == recorded_60m


def test_evidence_gate_requires_fifty_total_and_twenty_on_each_side():
    def event(index, location):
        return {
            "id": str(index),
            "opened_at_utc": (pd.Timestamp("2027-01-01T00:00:00Z") + pd.Timedelta(days=index)).isoformat(),
            "location": location,
            "status": "resolved",
            "horizons": {"60": {"direction_aligned_return_pct": 1.0}},
        }

    balanced = [event(i, "lower-edge") for i in range(25)] + [event(i + 25, "upper-edge") for i in range(25)]
    assert summarize_events(balanced)["evidence_gate_passed"] is True
    unbalanced = [event(i, "lower-edge") for i in range(31)] + [event(i + 31, "upper-edge") for i in range(19)]
    summary = summarize_events(unbalanced)
    assert summary["evidence_gate_passed"] is False
    assert summary["positive_directional_60m_rate_pct"] is None


def test_coincident_sessions_are_visible_rows_but_one_evidence_cohort():
    rows = []
    for index in range(25):
        opened = (pd.Timestamp("2027-01-01T00:00:00Z") + pd.Timedelta(days=index)).isoformat()
        location = "lower-edge" if index < 13 else "upper-edge"
        for session in ("london", "xetra"):
            rows.append(
                {
                    "id": f"{session}-{index}",
                    "opened_at_utc": opened,
                    "location": location,
                    "status": "resolved",
                    "horizons": {"60": {"direction_aligned_return_pct": 1.0}},
                }
            )
    summary = summarize_events(rows)
    assert summary["resolved_edge_session_rows"] == 50
    assert summary["resolved_edge_events"] == 25
    assert summary["evidence_gate_passed"] is False
