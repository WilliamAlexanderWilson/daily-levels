"""Prior week/month high-low and current week/month open, from daily candles."""

import pandas as pd


def get_reference_levels(daily_candles: pd.DataFrame, now: pd.Timestamp | None = None) -> dict:
    """Returns prior_week_high/low, prior_month_high/low, current_week_open,
    current_month_open. Any value is None if daily_candles doesn't cover
    that period (e.g. current_week_open is None if no candle has closed
    yet this ISO week)."""
    if now is None:
        now = pd.Timestamp.now(tz="UTC")

    candles = daily_candles.copy()
    iso = candles.index.isocalendar()
    candles["week_key"] = list(zip(iso["year"], iso["week"]))
    candles["month_key"] = list(zip(candles.index.year, candles.index.month))

    now_iso = now.isocalendar()
    current_week_key = (now_iso.year, now_iso.week)
    current_month_key = (now.year, now.month)

    def prior_key(series: pd.Series, current):
        earlier = sorted(k for k in series.unique() if k < current)
        return earlier[-1] if earlier else None

    prior_week_key = prior_key(candles["week_key"], current_week_key)
    prior_month_key = prior_key(candles["month_key"], current_month_key)

    result = {
        "prior_week_high": None,
        "prior_week_low": None,
        "prior_month_high": None,
        "prior_month_low": None,
        "current_week_open": None,
        "current_month_open": None,
    }

    if prior_week_key is not None:
        rows = candles[candles["week_key"] == prior_week_key]
        result["prior_week_high"] = float(rows["high"].max())
        result["prior_week_low"] = float(rows["low"].min())

    if prior_month_key is not None:
        rows = candles[candles["month_key"] == prior_month_key]
        result["prior_month_high"] = float(rows["high"].max())
        result["prior_month_low"] = float(rows["low"].min())

    current_week_rows = candles[candles["week_key"] == current_week_key]
    if not current_week_rows.empty:
        result["current_week_open"] = float(current_week_rows.iloc[0]["open"])

    current_month_rows = candles[candles["month_key"] == current_month_key]
    if not current_month_rows.empty:
        result["current_month_open"] = float(current_month_rows.iloc[0]["open"])

    return result
