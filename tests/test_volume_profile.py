"""Hand-verifiable volume profile test.

current_price=400 makes the bin width exactly 1.0 (400 * 0.0025), so bin
edges land on whole numbers and the volume-split-across-bins math can be
traced by hand. See the comment block below for the worked arithmetic.
"""

import pandas as pd
import pytest

from src.levels.volume_profile import build_volume_profile

# Candle layout (low, high, volume):
#   A: 100-102, vol 10
#   B: 102-104, vol 20
#   C: 104-106, vol 5
#   D: 108-110, vol 8
#
# bin_width = 1, range = [100, 110], so n_bins = 11 (bin i = [100+i, 101+i)).
# Each candle's volume splits evenly across the 3 bins its range touches:
#   A -> bins 0,1,2 get 10/3 = 3.333 each
#   B -> bins 2,3,4 get 20/3 = 6.667 each
#   C -> bins 4,5,6 get 5/3  = 1.667 each
#   D -> bins 8,9,10 get 8/3 = 2.667 each
#
# bin volumes: [3.333, 3.333, 10.0, 6.667, 8.333, 1.667, 1.667, 0, 2.667, 2.667, 2.667]
# POC = bin 2 (10.0) -> price (102+103)/2 = 102.5
# total = 43, value area target = 0.70 * 43 = 30.1
# expand from bin2: +bin3(6.667)=16.667, +bin4(8.333)=25.0,
#                    +bin1(3.333)=28.333, +bin0(3.333)=31.667 >= 30.1, stop
# value area = bins[0..4] -> VAL = 100, VAH = 105
CANDLES = pd.DataFrame(
    {
        "low": [100.0, 102.0, 104.0, 108.0],
        "high": [102.0, 104.0, 106.0, 110.0],
        "volume": [10.0, 20.0, 5.0, 8.0],
    }
)
CURRENT_PRICE = 400.0


def test_poc_val_vah_hand_computed():
    profile = build_volume_profile(CANDLES, CURRENT_PRICE)

    assert profile.poc == pytest.approx(102.5)
    assert profile.val == pytest.approx(100.0)
    assert profile.vah == pytest.approx(105.0)


def test_empty_candles_raises():
    with pytest.raises(ValueError):
        build_volume_profile(CANDLES.iloc[0:0], CURRENT_PRICE)
