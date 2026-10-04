"""Golden pocket: 0.618-0.65 retracement zone of the most recent swing leg."""

from dataclasses import dataclass

from config import GOLDEN_POCKET_HIGH, GOLDEN_POCKET_LOW, MIN_SWING_PCT
from src.levels.pivots import Pivot


@dataclass
class GoldenPocket:
    zone_low: float
    zone_high: float
    leg_start: Pivot
    leg_end: Pivot
    swing_pct: float


def _alternate_zigzag(pivots: list[Pivot]) -> list[Pivot]:
    """Collapse same-kind runs to the single most extreme pivot, so the
    result strictly alternates high/low."""
    filtered: list[Pivot] = []
    for p in pivots:
        if not filtered:
            filtered.append(p)
            continue
        last = filtered[-1]
        if p.kind == last.kind:
            more_extreme = (p.kind == "high" and p.price > last.price) or (
                p.kind == "low" and p.price < last.price
            )
            if more_extreme:
                filtered[-1] = p
        else:
            filtered.append(p)
    return filtered


def find_golden_pocket(
    pivots: list[Pivot], min_swing_pct: float = MIN_SWING_PCT
) -> GoldenPocket | None:
    """Find the most recent completed leg between alternating pivots that
    moved at least min_swing_pct, and return its 0.618-0.65 retracement
    zone. Returns None if no qualifying leg exists.
    """
    zigzag = _alternate_zigzag(pivots)
    if len(zigzag) < 2:
        return None

    qualifying = []
    for start, end in zip(zigzag, zigzag[1:]):
        pct_move = abs(end.price - start.price) / start.price * 100
        if pct_move >= min_swing_pct:
            qualifying.append((start, end, pct_move))

    if not qualifying:
        return None

    start, end, pct_move = max(qualifying, key=lambda leg: leg[1].date)

    leg_range = abs(end.price - start.price)
    if end.kind == "high":
        # up-leg: retracement support zone below the high
        fib_a = end.price - leg_range * GOLDEN_POCKET_LOW
        fib_b = end.price - leg_range * GOLDEN_POCKET_HIGH
    else:
        # down-leg: retracement resistance zone above the low
        fib_a = end.price + leg_range * GOLDEN_POCKET_LOW
        fib_b = end.price + leg_range * GOLDEN_POCKET_HIGH

    return GoldenPocket(
        zone_low=min(fib_a, fib_b),
        zone_high=max(fib_a, fib_b),
        leg_start=start,
        leg_end=end,
        swing_pct=pct_move,
    )
