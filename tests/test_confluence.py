"""Hand-verifiable confluence merging: levels within 0.5% of each other
(chained transitively) collapse into one zone; current_price=100."""

import pytest

from src.levels.confluence import RawLevel, merge_confluence

CURRENT_PRICE = 100.0


def test_merges_close_levels_and_tags_type_distance_strength():
    raw = [
        RawLevel("Flip support", 95.0, 95.0),
        RawLevel("A", 100.3, 100.3),
        RawLevel("B", 100.6, 100.6),
        RawLevel("C", 102.0, 102.0),
        RawLevel("D", 102.1, 102.1),
    ]

    merged = merge_confluence(raw, CURRENT_PRICE, merge_pct=0.005)

    assert len(merged) == 3

    flip = merged[0]
    assert flip.names == ["Flip support"]
    assert flip.price_low == pytest.approx(95.0)
    assert flip.price_high == pytest.approx(95.0)
    assert flip.type == "support"
    assert flip.distance_pct == pytest.approx(-5.0)
    assert flip.strength == 1
    assert flip.is_flip is True

    ab = merged[1]
    assert ab.names == ["A", "B"]
    assert ab.price_low == pytest.approx(100.3)
    assert ab.price_high == pytest.approx(100.6)
    assert ab.type == "resistance"  # midpoint 100.45 > 100
    assert ab.distance_pct == pytest.approx(0.45)
    assert ab.strength == 2
    assert ab.is_flip is False

    cd = merged[2]
    assert cd.names == ["C", "D"]
    assert cd.price_low == pytest.approx(102.0)
    assert cd.price_high == pytest.approx(102.1)
    assert cd.type == "resistance"
    assert cd.distance_pct == pytest.approx(2.05)
    assert cd.strength == 2
    assert cd.is_flip is False


def test_levels_far_apart_stay_separate():
    raw = [RawLevel("A", 90.0, 90.0), RawLevel("B", 110.0, 110.0)]
    merged = merge_confluence(raw, CURRENT_PRICE, merge_pct=0.005)
    assert len(merged) == 2
    assert [lvl.strength for lvl in merged] == [1, 1]


def test_empty_input_returns_empty_list():
    assert merge_confluence([], CURRENT_PRICE) == []
