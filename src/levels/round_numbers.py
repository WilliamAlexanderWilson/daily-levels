"""Round-number ("whole number") levels: psychological price levels at
clean round increments, scaled to price magnitude - nearest $1,000 for a
five-figure BTC price, nearest $100 for a four-figure ETH price, nearest
$10,000 if BTC is ever six figures, and so on. The step is 10**(digits-2)
where digits is the number of digits before the decimal point, so it
tracks price magnitude automatically with no per-asset constant to
maintain.

Purely arithmetic, not derived from trade data - unlike every other level
in this project, these are NOT part of the once-a-day "fixed until 5am"
snapshot. The live site computes them continuously from the live price
(reimplemented in site/app.js - keep both in sync if this formula
changes); the backtest computes them per replayed day to test whether
round numbers actually hold more than chance, same rigor as every other
level type.
"""

import math


def round_number_step(price: float) -> float:
    if price <= 0:
        raise ValueError("round_number_step: price must be positive")
    digits = math.floor(math.log10(price)) + 1
    return 10 ** (digits - 2)


def nearest_round_numbers(price: float) -> tuple[float, float]:
    """Returns (nearest round number below price, nearest round number
    above price). Never returns price itself even if price already lands
    exactly on a round number - steps one further out in that case, so
    the result is always a strict (below, above) pair."""
    step = round_number_step(price)
    below = math.floor(price / step) * step
    above = math.ceil(price / step) * step
    if below == price:
        below -= step
    if above == price:
        above += step
    return below, above
