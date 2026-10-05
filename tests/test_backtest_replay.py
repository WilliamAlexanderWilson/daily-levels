"""The no-lookahead guarantee: a day's computed levels must never reflect
price action that hasn't happened yet as of that day."""

import numpy as np
import pandas as pd

from src.backtest.replay import replay_levels

MIN_LOOKBACK_DAYS = 365  # max(RANGE_DAYS=60, PIVOT_LOOKBACK_DAYS=365)


def _flat_candles_with_future_spike(n_days: int, spike_at_day: int) -> pd.DataFrame:
    """n_days of boring, mildly-varying candles around price 100, except
    spike_at_day which jumps to 100,000 - a price no earlier day should
    ever see if the replay is correctly excluding future data."""
    dates = pd.date_range("2024-01-01", periods=n_days, freq="D", tz="UTC")
    rng = np.random.default_rng(seed=7)
    base = 100 + rng.normal(0, 0.5, size=n_days)

    opens = base.copy()
    closes = base + rng.normal(0, 0.2, size=n_days)
    highs = np.maximum(opens, closes) + 0.3
    lows = np.minimum(opens, closes) - 0.3
    volumes = np.full(n_days, 10.0)

    highs[spike_at_day] = 100_000.0
    closes[spike_at_day] = 100_000.0
    opens[spike_at_day] = 50_000.0
    lows[spike_at_day] = 50_000.0

    return pd.DataFrame(
        {"open": opens, "high": highs, "low": lows, "close": closes, "volume": volumes},
        index=dates,
    )


def test_replay_never_sees_a_future_spike():
    n_days = MIN_LOOKBACK_DAYS + 40
    spike_day_index = n_days - 1  # the very last day in the dataset
    candles = _flat_candles_with_future_spike(n_days, spike_day_index)

    snapshots = replay_levels(candles)

    assert len(snapshots) > 0
    # the earliest replayable day is well before the spike - none of its
    # levels should be anywhere near the spike price.
    first_snapshot = snapshots[0]
    for level in first_snapshot.levels:
        assert level["price_high"] < 1000, (
            f"level {level['name']} = {level['price_high']} saw the future spike"
        )

    # a snapshot computed ON the spike day (or after, if any exist) SHOULD
    # reflect it - proving the earlier assertion isn't just a tautology of
    # the engine ignoring spikes in general.
    spike_day_date = candles.index[spike_day_index]
    on_spike_day = [s for s in snapshots if s.date == spike_day_date]
    assert on_spike_day, "expected the spike day itself to be replayable"
    assert any(lvl["price_high"] > 1000 for lvl in on_spike_day[0].levels)


def test_replay_skips_days_without_enough_prior_history():
    candles = _flat_candles_with_future_spike(MIN_LOOKBACK_DAYS - 1, spike_at_day=0)
    snapshots = replay_levels(candles)
    assert snapshots == []


def test_replay_snapshot_count_matches_available_days():
    n_days = MIN_LOOKBACK_DAYS + 10
    candles = _flat_candles_with_future_spike(n_days, spike_at_day=0)
    snapshots = replay_levels(candles)
    # day index MIN_LOOKBACK_DAYS is the first with MIN_LOOKBACK_DAYS full
    # prior candles (indices 0..MIN_LOOKBACK_DAYS-1) behind it; everything
    # through the last day is replayable (0-indexed).
    assert len(snapshots) == n_days - MIN_LOOKBACK_DAYS
    assert snapshots[0].date == candles.index[MIN_LOOKBACK_DAYS]
    assert snapshots[-1].date == candles.index[-1]
