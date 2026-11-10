import pandas as pd
import pytest

from src.equities.range_context import build_range_context, completed_session_ohlc

ET = "America/New_York"


def _sessions(count=21, include_partial=False):
    days = pd.bdate_range("2026-09-01", periods=count)
    frames = []
    for number, day in enumerate(days):
        end = "12:00" if include_partial and number == len(days) - 1 else "15:55"
        index = pd.date_range(f"{day.date()} 09:30", f"{day.date()} {end}", freq="5min", tz=ET)
        base = 100 + number
        frames.append(pd.DataFrame({
            "open": base,
            "high": base + 2,
            "low": base - 2,
            "close": base + 1,
            "volume": 100,
        }, index=index))
    return pd.concat(frames).tz_convert("UTC")


def test_current_incomplete_session_is_excluded():
    frame = _sessions(21, include_partial=True)
    generated = frame.index.max() + pd.Timedelta(minutes=1)
    sessions = completed_session_ohlc(frame, generated)
    assert len(sessions) == 20
    assert sessions.index[-1].date().isoformat() == "2026-09-28"


def test_historical_partial_session_is_also_excluded_from_the_channel():
    frame = _sessions(21, include_partial=True)
    partial_date = frame.index[-1].tz_convert(ET).date()
    frame.loc[frame.index.tz_convert(ET).date == partial_date, "high"] = 999
    generated = pd.Timestamp("2026-10-01 17:00", tz=ET)
    result = build_range_context(frame, 112.0, generated)
    assert result["available"] is True
    assert result["window_end"] == "2026-09-28"
    assert result["high"] == pytest.approx(121.0)


def test_unverified_early_close_fails_closed_instead_of_setting_a_boundary():
    frame = _sessions(21)
    last_date = frame.index[-1].tz_convert(ET).date()
    local_times = frame.index.tz_convert(ET)
    keep = (local_times.date != last_date) | (local_times.time <= pd.Timestamp("13:00").time())
    frame = frame[keep]
    frame.loc[frame.index.tz_convert(ET).date == last_date, "low"] = 1
    result = build_range_context(frame, 112.0, pd.Timestamp("2026-10-01 17:00", tz=ET))
    assert result["available"] is True
    assert result["window_end"] == "2026-09-28"
    assert result["low"] == pytest.approx(98.0)


def test_channel_uses_prior_20_completed_sessions_and_fixed_edges():
    frame = _sessions(21)
    generated = pd.Timestamp("2026-10-01 17:00", tz=ET)
    result = build_range_context(frame, 112.0, generated)
    assert result["available"] is True
    assert result["window_start"] == "2026-09-02"
    assert result["window_end"] == "2026-09-29"
    assert result["low"] == pytest.approx(99.0)
    assert result["high"] == pytest.approx(122.0)
    assert result["midpoint"] == pytest.approx(110.5)
    assert result["lower_edge_max"] == pytest.approx(102.45)
    assert result["upper_edge_min"] == pytest.approx(118.55)
    assert result["state"] == "middle"
    assert result["is_signal"] is False


@pytest.mark.parametrize(
    ("price", "state"),
    [(98, "below_range"), (100, "lower_edge"), (120, "upper_edge"), (123, "above_range")],
)
def test_location_states_are_geometry_not_signals(price, state):
    result = build_range_context(_sessions(21), price, pd.Timestamp("2026-10-01 17:00", tz=ET))
    assert result["state"] == state
    assert result["is_signal"] is False


def test_insufficient_history_fails_closed():
    result = build_range_context(_sessions(10), 105, pd.Timestamp("2026-10-01 17:00", tz=ET))
    assert result == {
        "available": False,
        "method": "Prior 20 completed regular sessions",
        "reason": "Need 20 completed sessions; found 10.",
        "is_signal": False,
    }
