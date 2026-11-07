import pandas as pd

from src.session_reactions.engine import SessionOpen, analyze_session, build_reaction_payload


def _candles(days=35, interval_minutes=15):
    index = pd.date_range("2026-01-01", periods=days * 24 * 60 // interval_minutes, freq=f"{interval_minutes}min", tz="UTC")
    values = pd.Series(range(len(index)), index=index, dtype=float)
    close = 100 + values * 0.01
    return pd.DataFrame(
        {
            "open": close,
            "high": close + 0.1,
            "low": close - 0.1,
            "close": close + 0.05,
            "volume": 10.0,
        },
        index=index,
    )


def test_analyze_session_measures_all_horizons_and_sample_threshold():
    session = SessionOpen("utc-open", "UTC", 1, "UTC", 0, 0)
    result = analyze_session(_candles(), session, 15)
    assert result["evidence_status"] == "measured"
    assert result["horizons"]["15"]["n"] >= 20
    assert result["horizons"]["120"]["n"] >= 20
    assert result["horizons"]["60"]["median_abs_move_pct"] > 0
    assert result["median_volume_ratio_60m"] == 1.0


def test_missing_candles_are_not_silently_treated_as_complete_windows():
    frame = _candles(days=10).drop(pd.Timestamp("2026-01-05T00:15:00Z"))
    session = SessionOpen("utc-open", "UTC", 1, "UTC", 0, 0)
    result = analyze_session(frame, session, 15)
    assert result["horizons"]["15"]["n"] == 7
    assert result["horizons"]["30"]["n"] == 6


def test_payload_ranks_only_sessions_with_at_least_twenty_observations():
    payload = build_reaction_payload("btc", _candles(), 15, "fixture", "https://example.test", "test only")
    ranked = [session for session in payload["sessions"] if session["observed_rank"] is not None]
    assert len(ranked) == 7
    assert min(session["observed_rank"] for session in ranked) == 1
    assert all(isinstance(session["observed_rank"], int) for session in ranked)
    assert payload["methodology"]["minimum_samples_for_rank"] == 20
    assert "not a prediction" in payload["methodology"]["limitations"][0]
