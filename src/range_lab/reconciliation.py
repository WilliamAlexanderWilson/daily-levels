"""Compare the futures research candles with the spot chart candles.

The Range Lab is researched on PF_XBTUSD perpetual futures while the visible
dashboard chart is BTC/USD spot. This module quantifies that basis over the
bounded window Kraken makes available for spot OHLC; it does not decide that
either market is interchangeable or that a strategy is profitable.
"""

from __future__ import annotations

import pandas as pd

PRICE_COLUMNS = ("open", "high", "low", "close")


def _rounded(value: float) -> float:
    return round(float(value), 4)


def reconcile_spot_futures(futures: pd.DataFrame, spot: pd.DataFrame) -> dict:
    """Return timestamp coverage and OHLC basis for completed 4-hour bars."""
    if futures.empty or spot.empty:
        raise ValueError("Spot and futures candles are both required for reconciliation")
    for name, frame in (("futures", futures), ("spot", spot)):
        missing = [column for column in PRICE_COLUMNS if column not in frame]
        if missing:
            raise ValueError(f"{name} candles are missing {missing}")
        if not frame.index.is_unique:
            raise ValueError(f"{name} candle timestamps must be unique")

    futures = futures.sort_index()
    spot = spot.sort_index()
    if futures.index.max() < spot.index.min() or futures.index.min() > spot.index.max():
        raise ValueError("Spot and futures candles have no overlapping time window")

    # Spot is the intentionally bounded side of this comparison. Use its full
    # returned timestamp range so a futures gap at the first or last spot bar
    # cannot disappear merely because the shared-index endpoints moved inward.
    comparison_start = spot.index.min()
    comparison_end = spot.index.max()

    futures_window = futures.loc[comparison_start:comparison_end]
    spot_window = spot.loc[comparison_start:comparison_end]
    missing_in_spot = futures_window.index.difference(spot_window.index)
    missing_in_futures = spot_window.index.difference(futures_window.index)
    common = futures_window.index.intersection(spot_window.index)
    if common.empty:
        raise ValueError("Spot and futures candles share no timestamps")

    aligned_futures = futures_window.loc[common]
    aligned_spot = spot_window.loc[common]
    field_basis = {}
    for column in PRICE_COLUMNS:
        denominator = aligned_spot[column]
        if (denominator == 0).any():
            raise ValueError(f"Spot {column} contains a zero price")
        signed = (aligned_futures[column] - denominator) / denominator * 100
        absolute = signed.abs()
        field_basis[column] = {
            "mean_signed_pct": _rounded(signed.mean()),
            "median_signed_pct": _rounded(signed.median()),
            "median_abs_pct": _rounded(absolute.median()),
            "p95_abs_pct": _rounded(absolute.quantile(0.95)),
            "max_abs_pct": _rounded(absolute.max()),
        }

    close_signed = (
        (aligned_futures["close"] - aligned_spot["close"])
        / aligned_spot["close"]
        * 100
    )
    max_close_time = close_signed.abs().idxmax()
    futures_direction = (aligned_futures["close"] - aligned_futures["open"]).apply(
        lambda value: 1 if value > 0 else -1 if value < 0 else 0
    )
    spot_direction = (aligned_spot["close"] - aligned_spot["open"]).apply(
        lambda value: 1 if value > 0 else -1 if value < 0 else 0
    )
    envelope_overlap = (
        aligned_futures["low"].combine(aligned_spot["low"], max)
        <= aligned_futures["high"].combine(aligned_spot["high"], min)
    )

    return {
        "scope": "latest completed Kraken 4h BTC/USD spot bars available from the bounded recent-only endpoint",
        "futures_market": "PF_XBTUSD perpetual futures trade candles",
        "spot_market": "BTC/USD spot candles",
        "comparison_start": comparison_start.isoformat(),
        "comparison_end": comparison_end.isoformat(),
        "aligned_start": common[0].isoformat(),
        "aligned_end": common[-1].isoformat(),
        "overlap_candles": len(common),
        "futures_candles_in_window": len(futures_window),
        "spot_candles_in_window": len(spot_window),
        "missing_in_spot": len(missing_in_spot),
        "missing_in_futures": len(missing_in_futures),
        "missing_spot_timestamps": [timestamp.isoformat() for timestamp in missing_in_spot[:20]],
        "missing_futures_timestamps": [timestamp.isoformat() for timestamp in missing_in_futures[:20]],
        "field_basis": field_basis,
        "largest_close_basis": {
            "timestamp": max_close_time.isoformat(),
            "signed_pct": _rounded(close_signed.loc[max_close_time]),
        },
        "candle_direction_agreement_pct": _rounded(
            (futures_direction == spot_direction).mean() * 100
        ),
        "high_low_envelope_overlap_pct": _rounded(envelope_overlap.mean() * 100),
        "interpretation": (
            "Measures contract-versus-spot basis and timestamp coverage only. "
            "It does not validate the strategy or guarantee equivalent fills."
        ),
    }
