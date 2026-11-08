"""Detect a repeat-tested higher-timeframe reclaim boundary.

The creator-sourced $82.8k level was the May 6, 2026 Daily swing high
($82,790.90 on Kraken), later retested by several Daily pivot highs. This
module turns that observable reason into a deterministic daily calculation.

It does not predict direction. It reports the strongest repeated pivot-high
cluster and an explicitly defined two-close acceptance proxy. Both are
descriptive market-structure evidence, not an entry signal or a claim of edge.
"""

from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

import config
from src.levels.pivots import Pivot, find_pivots


METHOD_VERSION = "structural-reclaim-pivot-cluster-v1"


@dataclass(frozen=True)
class PivotCluster:
    members: tuple[Pivot, ...]

    @property
    def exact_price(self) -> float:
        return max(member.price for member in self.members)

    @property
    def origin(self) -> Pivot:
        return min(
            (member for member in self.members if member.price == self.exact_price),
            key=lambda member: member.date,
        )

    @property
    def first_date(self) -> pd.Timestamp:
        return min(member.date for member in self.members)

    @property
    def last_date(self) -> pd.Timestamp:
        return max(member.date for member in self.members)

    @property
    def span_days(self) -> int:
        return int((self.last_date - self.first_date).days)

    @property
    def distinct_months(self) -> int:
        return len({(member.date.year, member.date.month) for member in self.members})

    @property
    def rank(self) -> tuple[int, int, int, int]:
        """Prefer repeated, cross-month, durable, then recent structure."""
        return (
            len(self.members),
            self.distinct_months,
            self.span_days,
            int(self.last_date.timestamp()),
        )


def _candidate_clusters(
    pivots: list[Pivot],
    tolerance_pct: float,
    min_pivots: int,
    min_span_days: int,
) -> list[PivotCluster]:
    highs = [pivot for pivot in pivots if pivot.kind == "high"]
    seen: set[tuple[pd.Timestamp, ...]] = set()
    clusters: list[PivotCluster] = []

    for anchor in highs:
        members = tuple(
            pivot
            for pivot in highs
            if abs(pivot.price - anchor.price) / anchor.price * 100 <= tolerance_pct
        )
        key = tuple(member.date for member in members)
        if key in seen:
            continue
        seen.add(key)
        cluster = PivotCluster(members)
        if len(members) < min_pivots or cluster.span_days < min_span_days:
            continue
        clusters.append(cluster)

    return clusters


def _acceptance(candles: pd.DataFrame, boundary: float, required_closes: int) -> dict:
    recent = candles.tail(required_closes)
    closes = [float(value) for value in recent["close"]]
    dates = [timestamp.date().isoformat() for timestamp in recent.index]
    if len(closes) < required_closes:
        state = "insufficient-data"
    elif all(close > boundary for close in closes):
        state = "accepted-above"
    elif all(close < boundary for close in closes):
        state = "accepted-below"
    else:
        state = "testing"
    return {
        "state": state,
        "rule": f"{required_closes} consecutive completed Daily closes",
        "closes": [
            {"date": date, "close": close}
            for date, close in zip(dates, closes, strict=True)
        ],
    }


def detect_structural_reclaim(
    candles: pd.DataFrame,
    *,
    pivot_n: int = config.PIVOT_N,
    lookback_days: int = config.STRUCTURAL_RECLAIM_LOOKBACK_DAYS,
    tolerance_pct: float = config.STRUCTURAL_RECLAIM_CLUSTER_TOLERANCE_PCT,
    min_pivots: int = config.STRUCTURAL_RECLAIM_MIN_PIVOTS,
    min_span_days: int = config.STRUCTURAL_RECLAIM_MIN_SPAN_DAYS,
    acceptance_closes: int = config.STRUCTURAL_RECLAIM_ACCEPTANCE_CLOSES,
    display_increment: float = config.STRUCTURAL_RECLAIM_DISPLAY_INCREMENT,
) -> dict | None:
    """Return the strongest repeat-tested Daily pivot-high cluster.

    The input must contain completed candles only. ``src.fetch`` already
    removes Kraken's forming candle before this function is called.
    """
    if candles.empty or len(candles) < pivot_n * 2 + 1:
        return None

    cutoff = candles.index.max() - pd.Timedelta(days=lookback_days)
    window = candles[candles.index >= cutoff]
    clusters = _candidate_clusters(
        find_pivots(window, n=pivot_n),
        tolerance_pct=tolerance_pct,
        min_pivots=min_pivots,
        min_span_days=min_span_days,
    )
    if not clusters:
        return None

    selected = max(clusters, key=lambda cluster: cluster.rank)
    exact_price = selected.exact_price
    display_price = round(exact_price / display_increment) * display_increment
    established = (
        len(selected.members) >= config.STRUCTURAL_RECLAIM_ESTABLISHED_PIVOTS
        and selected.distinct_months >= config.STRUCTURAL_RECLAIM_ESTABLISHED_MONTHS
        and selected.span_days >= config.STRUCTURAL_RECLAIM_ESTABLISHED_SPAN_DAYS
    )

    return {
        "method_version": METHOD_VERSION,
        "data_source": "Kraken BTC/USD completed Daily candles",
        "lookback_days": lookback_days,
        "pivot_window_bars": pivot_n,
        "cluster_tolerance_pct": tolerance_pct,
        "selection_rule": "strongest cluster by pivots, distinct months, span, then recency",
        "quality": "established" if established else "developing",
        "boundary": {
            "exact_price": exact_price,
            "display_price": display_price,
            "origin_date": selected.origin.date.date().isoformat(),
            "origin_high": selected.origin.price,
            "first_test_date": selected.first_date.date().isoformat(),
            "last_test_date": selected.last_date.date().isoformat(),
            "pivot_count": len(selected.members),
            "distinct_months": selected.distinct_months,
            "span_days": selected.span_days,
            "tests": [
                {"date": member.date.date().isoformat(), "high": member.price}
                for member in selected.members
            ],
        },
        "acceptance": _acceptance(candles, exact_price, acceptance_closes),
        "caveat": "Calculated structure, not a prediction, signal, or guarantee.",
    }
