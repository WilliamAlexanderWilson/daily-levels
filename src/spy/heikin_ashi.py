"""Resampling real 5m candles into coarser timeframes, and converting real
OHLC into Heikin-Ashi OHLC. Kept strictly separate: pattern detection runs
on the Heikin-Ashi series (that's what the strategy is defined on), but
every entry/exit price in the backtest comes from the REAL series. HA close
is a smoothed average, not a price that ever actually traded - pricing an
option off it would be a silent lookahead/fiction bug, not a backtest.
"""

import pandas as pd

TIMEFRAMES_MINUTES = (10, 15, 20, 30)


def resample_session(df_5m: pd.DataFrame, minutes: int) -> pd.DataFrame:
    """Resamples 5m OHLCV into `minutes`-wide bars, anchored to each trading
    day's own first bar (regular session open, e.g. 9:30 ET) rather than
    midnight - 9:30 divides evenly into 10/15/20/30 minutes, midnight
    doesn't, so anchoring to midnight would produce bars that straddle the
    real session's natural boundaries."""
    out = []
    for _, day_df in df_5m.groupby(df_5m.index.tz_convert("America/New_York").date):
        # label="right" so the index is each bar's CLOSE time - a bar can
        # only be evaluated once it has finished forming, and every
        # downstream consumer (signal detection, entry pricing) keys off
        # "when did this candle actually close."
        resampled = day_df.resample(
            f"{minutes}min", origin="start", closed="left", label="right"
        ).agg({"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"})
        out.append(resampled.dropna(how="any"))
    return pd.concat(out).sort_index()


def to_heikin_ashi(df: pd.DataFrame) -> pd.DataFrame:
    """Standard Heikin-Ashi transform:
        ha_close = (open + high + low + close) / 4
        ha_open  = (prior ha_open + prior ha_close) / 2   (first bar: (open+close)/2)
        ha_high  = max(high, ha_open, ha_close)
        ha_low   = min(low, ha_open, ha_close)
    """
    ha_close = (df["open"] + df["high"] + df["low"] + df["close"]) / 4

    ha_open = pd.Series(index=df.index, dtype=float)
    ha_open.iloc[0] = (df["open"].iloc[0] + df["close"].iloc[0]) / 2
    for i in range(1, len(df)):
        ha_open.iloc[i] = (ha_open.iloc[i - 1] + ha_close.iloc[i - 1]) / 2

    ha_high = pd.concat([df["high"], ha_open, ha_close], axis=1).max(axis=1)
    ha_low = pd.concat([df["low"], ha_open, ha_close], axis=1).min(axis=1)

    return pd.DataFrame(
        {"ha_open": ha_open, "ha_high": ha_high, "ha_low": ha_low, "ha_close": ha_close},
        index=df.index,
    )


def build_timeframes(df_5m: pd.DataFrame) -> dict[int, pd.DataFrame]:
    """Returns {minutes: DataFrame} for each of TIMEFRAMES_MINUTES, each
    frame carrying both the real resampled OHLC (open/high/low/close/volume)
    and the Heikin-Ashi columns (ha_open/ha_high/ha_low/ha_close) side by
    side, so a caller never has to re-join them."""
    frames = {}
    for minutes in TIMEFRAMES_MINUTES:
        real = resample_session(df_5m, minutes)
        ha = to_heikin_ashi(real)
        frames[minutes] = real.join(ha)
    return frames
