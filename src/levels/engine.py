"""Orchestrates the full level engine for one asset: fetch -> volume
profile, pivots, golden pocket, reference levels, flip levels -> confluence
merge -> a single serializable result."""

import pandas as pd

import config
from src.fetch import fetch_candles
from src.levels.confluence import RawLevel, merge_confluence
from src.levels.flip_level import find_flip_levels
from src.levels.golden_pocket import find_golden_pocket
from src.levels.pivots import find_pivots
from src.levels.reference_levels import get_reference_levels
from src.levels.volume_profile import build_volume_profile


def _lookback(candles: pd.DataFrame, days: int) -> pd.DataFrame:
    cutoff = candles.index.max() - pd.Timedelta(days=days)
    return candles[candles.index >= cutoff]


def build_asset_levels(pair: str) -> dict:
    """Runs the full engine for a Kraken pair (e.g. "BTC/USD"). Returns a
    dict with generated_at (UTC + Central), price, the config snapshot
    used, and the merged, tagged level list — plus the 4h/daily candles
    so the caller can also write chart data."""
    candles_4h = fetch_candles(pair, config.INTERVAL_4H)
    candles_1d = fetch_candles(pair, config.INTERVAL_1D)
    current_price = float(candles_4h["close"].iloc[-1])

    vp_candles = _lookback(candles_4h, config.RANGE_DAYS)
    vp = build_volume_profile(vp_candles, current_price)
    range_high = float(vp_candles["high"].max())
    range_low = float(vp_candles["low"].min())

    pivot_candles = _lookback(candles_1d, config.PIVOT_LOOKBACK_DAYS)
    pivots = find_pivots(pivot_candles)
    golden_pocket = find_golden_pocket(pivots)

    ref = get_reference_levels(candles_1d)
    flips = find_flip_levels(pivots, candles_1d, current_price)

    # POC/VAH/VAL/range high-low all come from the same RANGE_DAYS lookback
    # of 4h candles - naming that explicitly keeps the labels honest when
    # the chart is zoomed out further than that window (e.g. the Daily
    # view defaults to ~2 years of history; without this a viewer sees an
    # older, bigger wick elsewhere on screen and reasonably assumes "Range
    # high" is wrong, when it's just scoped to the last RANGE_DAYS days).
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

    now_utc = pd.Timestamp.now(tz="UTC")
    now_central = now_utc.tz_convert(config.LOCAL_TIMEZONE)

    levels_out = [
        {
            "name": lvl.label,
            "price_low": lvl.price_low,
            "price_high": lvl.price_high,
            "type": lvl.type,
            "distance_pct": lvl.distance_pct,
            "strength": lvl.strength,
            "is_flip": lvl.is_flip,
        }
        for lvl in merged
    ]

    golden_pocket_out = None
    if golden_pocket is not None:
        golden_pocket_out = {
            "zone_low": golden_pocket.zone_low,
            "zone_high": golden_pocket.zone_high,
            "swing_pct": golden_pocket.swing_pct,
            "leg_start_price": golden_pocket.leg_start.price,
            "leg_start_date": golden_pocket.leg_start.date.isoformat(),
            "leg_end_price": golden_pocket.leg_end.price,
            "leg_end_date": golden_pocket.leg_end.date.isoformat(),
        }

    result = {
        "generated_at_utc": now_utc.isoformat(),
        "generated_at_central": now_central.isoformat(),
        "price": current_price,
        "config": {
            "range_days": config.RANGE_DAYS,
            "volume_bin_pct": config.VOLUME_BIN_PCT,
            "value_area_pct": config.VALUE_AREA_PCT,
            "pivot_n": config.PIVOT_N,
            "min_swing_pct": config.MIN_SWING_PCT,
            "golden_pocket_range": [config.GOLDEN_POCKET_LOW, config.GOLDEN_POCKET_HIGH],
            "pivot_lookback_days": config.PIVOT_LOOKBACK_DAYS,
            "confluence_merge_pct": config.CONFLUENCE_MERGE_PCT,
        },
        "levels": levels_out,
        "golden_pocket_leg": golden_pocket_out,
    }

    return {"result": result, "candles_4h": candles_4h, "candles_1d": candles_1d}
