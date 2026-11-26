"""SPY chart candles from genuine Alpaca 1-minute IEX bars.

Display bars are independent of frozen research inputs. The default preserves
the existing regular-hours research archive. Extended charts use separate
premarket, regular, and after-hours segments anchored in New York time.
"""

import pandas as pd

CHART_TIMEFRAMES_MINUTES = (1, 5, 10, 15, 20, 30, 60, 240)
SESSION_OPEN_MINUTE = 9 * 60 + 30
SESSION_CLOSE_MINUTE = 16 * 60


def build_chart_timeframes(real_1m: pd.DataFrame, generated_at: pd.Timestamp, *, extended_hours: bool = False) -> dict[int, pd.DataFrame]:
    """Return completed OHLCV bars without synthesizing missing prints."""
    if real_1m.empty or real_1m.index.tz is None:
        raise ValueError("SPY 1-minute chart source must have timezone-aware bars")
    cutoff = pd.Timestamp(generated_at)
    if cutoff.tzinfo is None:
        raise ValueError("SPY chart generation time must be timezone-aware")

    if extended_hours:
        # Separate session segments preserve the 9:30 regular-session anchor.
        # The input contains actual exchange prints only; empty bins stay empty.
        local = real_1m.index.tz_convert("America/New_York")
        early = {"2024-07-03", "2024-11-29", "2024-12-24", "2025-07-03", "2025-11-28", "2025-12-24",
                 "2026-11-27", "2026-12-24", "2027-11-26"}
        pieces = {minutes: [] for minutes in CHART_TIMEFRAMES_MINUTES}
        for date, day in real_1m.groupby(local.date):
            close = 780 if str(date) in early else SESSION_CLOSE_MINUTE
            midnight = pd.Timestamp(date).tz_localize("America/New_York")
            for start, end in ((240, 570), (570, close), (close, 1200)):
                begin = midnight + pd.Timedelta(minutes=start)
                finish = midnight + pd.Timedelta(minutes=end)
                segment = day[(day.index >= begin) & (day.index < finish)]
                if segment.empty:
                    continue
                for minutes in CHART_TIMEFRAMES_MINUTES:
                    bars = segment.resample(f"{minutes}min", origin=begin, closed="left", label="right").agg(
                        {"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"}
                    ).dropna()
                    bars.index = pd.to_datetime([min(time, finish) for time in bars.index], utc=True)
                    pieces[minutes].append(bars[bars.index <= cutoff])
        return {minutes: pd.concat(parts).sort_index() if parts else real_1m.iloc[:0].copy()
                for minutes, parts in pieces.items()}

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
