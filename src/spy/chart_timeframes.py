"""SPY chart candles from genuine Alpaca 1-minute IEX bars.

These regular-session display bars are independent of the frozen 5-minute
research inputs. Every interval starts at 9:30 AM New York time; a final
short bin closes at 4 PM instead of carrying a future 4-hour timestamp.
"""

import pandas as pd

CHART_TIMEFRAMES_MINUTES = (1, 5, 10, 15, 20, 30, 60, 240)
SESSION_OPEN_MINUTE = 9 * 60 + 30
SESSION_CLOSE_MINUTE = 16 * 60


def build_chart_timeframes(real_1m: pd.DataFrame, generated_at: pd.Timestamp) -> dict[int, pd.DataFrame]:
    """Return completed regular-session OHLCV bars for every chart interval."""
    if real_1m.empty or real_1m.index.tz is None:
        raise ValueError("SPY 1-minute chart source must have timezone-aware bars")
    cutoff = pd.Timestamp(generated_at)
    if cutoff.tzinfo is None:
        raise ValueError("SPY chart generation time must be timezone-aware")

    local_index = real_1m.index.tz_convert("America/New_York")
    minute_of_day = local_index.hour * 60 + local_index.minute
    regular = (minute_of_day >= SESSION_OPEN_MINUTE) & (minute_of_day < SESSION_CLOSE_MINUTE)
    source = real_1m.loc[regular, ["open", "high", "low", "close", "volume"]]
    if source.empty:
        raise ValueError("Alpaca returned no regular-session SPY 1-minute bars")
    local_index = local_index[regular]
    offsets = minute_of_day[regular] - SESSION_OPEN_MINUTE
    session_dates = local_index.date

    frames = {}
    for minutes in CHART_TIMEFRAMES_MINUTES:
        buckets = offsets // minutes
        grouped = source.groupby([session_dates, buckets], sort=True).agg(
            open=("open", "first"),
            high=("high", "max"),
            low=("low", "min"),
            close=("close", "last"),
            volume=("volume", "sum"),
        )
        dates = pd.DatetimeIndex(pd.to_datetime(grouped.index.get_level_values(0)))
        session_open = dates.tz_localize("America/New_York") + pd.Timedelta(minutes=SESSION_OPEN_MINUTE)
        close_offsets = [min((int(bucket) + 1) * minutes, SESSION_CLOSE_MINUTE - SESSION_OPEN_MINUTE)
                         for bucket in grouped.index.get_level_values(1)]
        grouped.index = (session_open + pd.to_timedelta(close_offsets, unit="m")).tz_convert("UTC")
        frames[minutes] = grouped[grouped.index <= cutoff].sort_index()
    return frames
