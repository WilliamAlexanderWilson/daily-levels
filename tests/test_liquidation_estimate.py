"""Hand-verifiable liquidation-estimate test.

bin_edges = [0, 10, 20, ..., 200] (bin_width=10, 20 bins), all volume (40)
sits in bin 10 = [100, 110), entry_price = 105. current_price = 105.
leverage_tiers = [10, 25, 50, 100] -> share per (tier, side) = 40 / 8 = 5.

  lev=10:  long = 105*0.90 = 94.5  -> bin 9  [90,100)
           short = 105*1.10 = 115.5 -> bin 11 [110,120)
  lev=25:  long = 105*0.96 = 100.8 -> bin 10 [100,110) (same bin as entry)
           short = 105*1.04 = 109.2 -> bin 10
  lev=50:  long = 105*0.98 = 102.9 -> bin 10
           short = 105*1.02 = 107.1 -> bin 10
  lev=100: long = 105*0.99 = 103.95 -> bin 10
           short = 105*1.01 = 106.05 -> bin 10

long_acc:  bin9 = 5,  bin10 = 15 (3 tiers x 5)
short_acc: bin10 = 15 (3 tiers x 5), bin11 = 5
peak = 15 -> bin9 long=1/3, bin10 long=short=1.0, bin11 short=1/3
"""

import pytest

from src.levels.liquidation_estimate import estimate_liquidation_bins
from src.levels.volume_profile import VolumeProfile

BIN_EDGES = [float(10 * i) for i in range(21)]  # 0..200
BIN_VOLUMES = [0.0] * 20
BIN_VOLUMES[10] = 40.0
VP = VolumeProfile(poc=105.0, vah=110.0, val=100.0, bin_edges=BIN_EDGES, bin_volumes=BIN_VOLUMES)
CURRENT_PRICE = 105.0
TIERS = [10, 25, 50, 100]


def test_hand_computed_bins():
    bins = estimate_liquidation_bins(VP, CURRENT_PRICE, leverage_tiers=TIERS, max_distance_pct=1.0)
    by_price = {(b.price_low, b.price_high): b for b in bins}

    assert set(by_price.keys()) == {(90.0, 100.0), (100.0, 110.0), (110.0, 120.0)}

    bin9 = by_price[(90.0, 100.0)]
    assert bin9.long_intensity == pytest.approx(5 / 15)
    assert bin9.short_intensity == 0.0

    bin10 = by_price[(100.0, 110.0)]
    assert bin10.long_intensity == pytest.approx(1.0)
    assert bin10.short_intensity == pytest.approx(1.0)

    bin11 = by_price[(110.0, 120.0)]
    assert bin11.long_intensity == 0.0
    assert bin11.short_intensity == pytest.approx(5 / 15)


def test_max_distance_filters_out_far_projections():
    # bin 9 (long, 10.5 away from current_price=105, ~10%) and bin 11
    # (short, ~10%) both sit inside bin 10 (no distance) - a max_distance
    # tight enough to exclude ~10%-away projections should drop bins 9/11
    # entirely but keep bin 10 (the entry's own bin, effectively 0% away).
    bins = estimate_liquidation_bins(VP, CURRENT_PRICE, leverage_tiers=TIERS, max_distance_pct=0.05)
    prices = {(b.price_low, b.price_high) for b in bins}
    assert prices == {(100.0, 110.0)}


def test_no_volume_returns_empty():
    empty_vp = VolumeProfile(poc=105.0, vah=110.0, val=100.0, bin_edges=BIN_EDGES, bin_volumes=[0.0] * 20)
    assert estimate_liquidation_bins(empty_vp, CURRENT_PRICE) == []


def test_empty_profile_returns_empty():
    empty_vp = VolumeProfile(poc=0.0, vah=0.0, val=0.0, bin_edges=[], bin_volumes=[])
    assert estimate_liquidation_bins(empty_vp, CURRENT_PRICE) == []
