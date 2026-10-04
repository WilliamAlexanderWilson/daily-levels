"""Volume profile: POC and value area over a lookback window of candles."""

from dataclasses import dataclass

import pandas as pd

from config import VALUE_AREA_PCT, VOLUME_BIN_PCT


@dataclass
class VolumeProfile:
    poc: float          # price with the most volume
    vah: float          # value area high
    val: float          # value area low
    bin_edges: list[float]
    bin_volumes: list[float]


def build_volume_profile(candles: pd.DataFrame, current_price: float) -> VolumeProfile:
    """Build a volume profile from OHLCV candles.

    Each candle's volume is spread evenly across the bins its [low, high]
    range touches. Bin width is a fixed fraction of current_price, so bins
    are evenly spaced in price regardless of the candles' own range.
    """
    if candles.empty:
        raise ValueError("build_volume_profile: candles is empty")

    bin_width = current_price * VOLUME_BIN_PCT
    range_low = candles["low"].min()
    range_high = candles["high"].max()

    n_bins = max(1, int((range_high - range_low) / bin_width) + 1)
    bin_edges = [range_low + i * bin_width for i in range(n_bins + 1)]
    bin_volumes = [0.0] * n_bins

    for _, candle in candles.iterrows():
        low, high, volume = candle["low"], candle["high"], candle["volume"]
        lo_idx = max(0, min(n_bins - 1, int((low - range_low) / bin_width)))
        hi_idx = max(0, min(n_bins - 1, int((high - range_low) / bin_width)))
        touched = range(lo_idx, hi_idx + 1)
        share = volume / len(touched)
        for i in touched:
            bin_volumes[i] += share

    poc_idx = max(range(n_bins), key=lambda i: bin_volumes[i])
    poc_price = (bin_edges[poc_idx] + bin_edges[poc_idx + 1]) / 2

    total_volume = sum(bin_volumes)
    target = total_volume * VALUE_AREA_PCT
    covered = bin_volumes[poc_idx]
    lo, hi = poc_idx, poc_idx

    while covered < target and (lo > 0 or hi < n_bins - 1):
        vol_below = bin_volumes[lo - 1] if lo > 0 else -1
        vol_above = bin_volumes[hi + 1] if hi < n_bins - 1 else -1
        if vol_above >= vol_below:
            hi += 1
            covered += bin_volumes[hi]
        else:
            lo -= 1
            covered += bin_volumes[lo]

    val_price = bin_edges[lo]
    vah_price = bin_edges[hi + 1]

    return VolumeProfile(
        poc=poc_price,
        vah=vah_price,
        val=val_price,
        bin_edges=bin_edges,
        bin_volumes=bin_volumes,
    )
