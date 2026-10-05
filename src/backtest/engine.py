"""A daily-candle-only approximation of the live level engine, for
backtesting. Kraken caps history at 720 candles regardless of interval, so
4h candles only go back ~120 days - too thin to replay the volume-profile
levels (POC/VAH/VAL/Range) with any real sample size. This module runs the
same volume-profile/pivot/golden-pocket/reference/flip/confluence logic as
src/levels/engine.py, but feeds it daily candles everywhere, trading
precision for ~720 days of replay depth instead of ~60.

The live engine is untouched. This is backtest-only.
"""

import pandas as pd

import config
from src.levels.confluence import RawLevel, merge_confluence
from src.levels.flip_level import find_flip_levels
from src.levels.golden_pocket import find_golden_pocket
from src.levels.pivots import find_pivots
from src.levels.reference_levels import get_reference_levels
from src.levels.volume_profile import build_volume_profile


def _lookback(candles: pd.DataFrame, days: int) -> pd.DataFrame:
    cutoff = candles.index.max() - pd.Timedelta(days=days)
    return candles[candles.index >= cutoff]


def build_levels_for_day(candles_1d: pd.DataFrame) -> list[dict]:
    """Computes the same-shaped level list as the live engine, using only
    daily candles up to and including the last row of candles_1d. Callers
    control the no-lookahead guarantee by truncating candles_1d themselves
    before calling this.
    """
    current_price = float(candles_1d["close"].iloc[-1])

    vp_candles = _lookback(candles_1d, config.RANGE_DAYS)
    vp = build_volume_profile(vp_candles, current_price)
    range_high = float(vp_candles["high"].max())
    range_low = float(vp_candles["low"].min())

    pivot_candles = _lookback(candles_1d, config.PIVOT_LOOKBACK_DAYS)
    pivots = find_pivots(pivot_candles)
    golden_pocket = find_golden_pocket(pivots)

    ref = get_reference_levels(candles_1d, now=candles_1d.index[-1])
    flips = find_flip_levels(pivots, candles_1d, current_price)

    window_suffix = f"({config.RANGE_DAYS}d)"
    raw_levels = [
        RawLevel(f"POC {window_suffix}", vp.poc, vp.poc),
        RawLevel(f"VAH {window_suffix}", vp.vah, vp.vah),
        RawLevel(f"VAL {window_suffix}", vp.val, vp.val),
        RawLevel(f"Range high {window_suffix}", range_high, range_high),
        RawLevel(f"Range low {window_suffix}", range_low, range_low),
    ]

    if golden_pocket is not None:
        raw_levels.append(
            RawLevel("Golden pocket", golden_pocket.zone_low, golden_pocket.zone_high)
        )

    ref_name_map = {
        "prior_week_high": "Prior week high",
        "prior_week_low": "Prior week low",
        "prior_month_high": "Prior month high",
        "prior_month_low": "Prior month low",
        "current_week_open": "Current week open",
        "current_month_open": "Current month open",
    }
    for key, name in ref_name_map.items():
        value = ref[key]
        if value is not None:
            raw_levels.append(RawLevel(name, value, value))

    if flips["flip_support"] is not None:
        price = flips["flip_support"].price
        raw_levels.append(RawLevel("Flip support", price, price))
    if flips["flip_resistance"] is not None:
        price = flips["flip_resistance"].price
        raw_levels.append(RawLevel("Flip resistance", price, price))

    merged = merge_confluence(raw_levels, current_price)
    merged.sort(key=lambda lvl: lvl.midpoint)

    return [
        {
            "name": lvl.label,
            "price_low": lvl.price_low,
            "price_high": lvl.price_high,
            "type": lvl.type,
            "strength": lvl.strength,
            "is_flip": lvl.is_flip,
        }
        for lvl in merged
    ]
