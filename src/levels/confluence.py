"""Merge levels that sit within CONFLUENCE_MERGE_PCT of each other into a
single named zone, and tag each resulting level with type/distance/strength."""

from dataclasses import dataclass, field

from config import CONFLUENCE_MERGE_PCT


@dataclass
class RawLevel:
    name: str
    price_low: float
    price_high: float  # equal to price_low for a point level

    @property
    def midpoint(self) -> float:
        return (self.price_low + self.price_high) / 2


@dataclass
class Level:
    price_low: float
    price_high: float
    names: list[str] = field(default_factory=list)
    type: str = ""       # "resistance" or "support"
    distance_pct: float = 0.0
    strength: int = 1
    is_flip: bool = False  # true if a "must hold" flip level is among the merged names

    @property
    def midpoint(self) -> float:
        return (self.price_low + self.price_high) / 2

    @property
    def label(self) -> str:
        return " + ".join(self.names)


def merge_confluence(
    raw_levels: list[RawLevel], current_price: float, merge_pct: float = CONFLUENCE_MERGE_PCT
) -> list[Level]:
    """Greedily merges levels into clusters: sorted by price, a level joins
    the current cluster if it's within merge_pct of that cluster's running
    average price, otherwise it starts a new cluster. This chains
    transitively — A+B+C can merge even if A and C alone are more than
    merge_pct apart, as long as each is close to its neighbor.
    """
    if not raw_levels:
        return []

    sorted_levels = sorted(raw_levels, key=lambda lvl: lvl.midpoint)

    clusters: list[list[RawLevel]] = []
    cluster_ref_price: list[float] = []

    for lvl in sorted_levels:
        if clusters:
            ref = cluster_ref_price[-1]
            if abs(lvl.midpoint - ref) / ref <= merge_pct:
                clusters[-1].append(lvl)
                members = clusters[-1]
                cluster_ref_price[-1] = sum(m.midpoint for m in members) / len(members)
                continue
        clusters.append([lvl])
        cluster_ref_price.append(lvl.midpoint)

    merged: list[Level] = []
    for members in clusters:
        price_low = min(m.price_low for m in members)
        price_high = max(m.price_high for m in members)
        mid = (price_low + price_high) / 2
        merged.append(
            Level(
                price_low=price_low,
                price_high=price_high,
                names=[m.name for m in members],
                type="resistance" if mid > current_price else "support",
                distance_pct=(mid - current_price) / current_price * 100,
                strength=len(members),
                is_flip=any(m.name.startswith("Flip") for m in members),
            )
        )

    return merged
