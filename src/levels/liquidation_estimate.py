"""Estimated long/short liquidation density - a MODEL, not verified data.

No exchange (Kraken included) publishes real position entry prices or
leverage, so there is no way to show actual liquidation levels. This
instead projects the real volume profile (actual traded volume at each
price over the lookback window - the same data POC/VAH/VAL are built
from) forward through a handful of standard perp leverage tiers:

    long liquidation price  = entry * (1 - 1/leverage)   [below entry]
    short liquidation price = entry * (1 + 1/leverage)   [above entry]

Each volume bin's volume is split evenly across every tier in
LIQUIDATION_LEVERAGE_TIERS and evenly between long and short - not
because that's necessarily true, but because there is no real signal
(Kraken's open-interest number is a single aggregate; it doesn't say
how it splits by side or leverage) to weight either split any other
way, and assuming an even split is the most honest default available.

The result is a relative density, not an absolute size: a bin twice as
"hot" as another means twice as much of the real volume behind it
projects a liquidation there, not "twice as many dollars" or "this will
definitely happen." Treat it the same way you'd treat any heatmap like
this from a third-party tool - a plausible read on where crowded
leverage *might* sit, built transparently from real data plus a stated,
simple assumption, not a fact.
"""

from dataclasses import dataclass

import config
from src.levels.volume_profile import VolumeProfile


@dataclass
class LiquidationBin:
    price_low: float
    price_high: float
    long_intensity: float   # 0-1, relative to the hottest bin on either side
    short_intensity: float  # 0-1, relative to the hottest bin on either side


def estimate_liquidation_bins(
    vp: VolumeProfile,
    current_price: float,
    leverage_tiers: list[int] = None,
    max_distance_pct: float = None,
) -> list[LiquidationBin]:
    """Projects vp's real volume-at-price bins into estimated long/short
    liquidation density, re-bucketed onto vp's own bin grid. See module
    docstring for the exact assumptions."""
    leverage_tiers = leverage_tiers if leverage_tiers is not None else config.LIQUIDATION_LEVERAGE_TIERS
    max_distance_pct = (
        max_distance_pct if max_distance_pct is not None else config.LIQUIDATION_MAX_DISTANCE_PCT
    )

    n_bins = len(vp.bin_volumes)
    if n_bins == 0:
        return []

    bin_width = vp.bin_edges[1] - vp.bin_edges[0]
    range_low = vp.bin_edges[0]
    long_acc = [0.0] * n_bins
    short_acc = [0.0] * n_bins

    shares_per_bin = len(leverage_tiers) * 2  # each tier, long and short
    min_price = current_price * (1 - max_distance_pct)
    max_price = current_price * (1 + max_distance_pct)

    for i in range(n_bins):
        volume = vp.bin_volumes[i]
        if volume <= 0:
            continue
        entry_price = (vp.bin_edges[i] + vp.bin_edges[i + 1]) / 2
        share = volume / shares_per_bin

        for lev in leverage_tiers:
            long_liq = entry_price * (1 - 1 / lev)
            if min_price <= long_liq <= max_price:
                idx = int((long_liq - range_low) / bin_width)
                if 0 <= idx < n_bins:
                    long_acc[idx] += share

            short_liq = entry_price * (1 + 1 / lev)
            if min_price <= short_liq <= max_price:
                idx = int((short_liq - range_low) / bin_width)
                if 0 <= idx < n_bins:
                    short_acc[idx] += share

    peak = max(long_acc + short_acc, default=0.0) or 1.0

    return [
        LiquidationBin(
            price_low=vp.bin_edges[i],
            price_high=vp.bin_edges[i + 1],
            long_intensity=long_acc[i] / peak,
            short_intensity=short_acc[i] / peak,
        )
        for i in range(n_bins)
        if long_acc[i] > 0 or short_acc[i] > 0
    ]
