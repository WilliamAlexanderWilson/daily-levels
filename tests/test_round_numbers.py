"""Hand-verifiable round-number step/nearest calculations."""

import pytest

from src.levels.round_numbers import nearest_round_numbers, round_number_step


def test_step_for_five_figure_btc_price():
    assert round_number_step(85761.80) == 1000


def test_step_for_four_figure_eth_price():
    assert round_number_step(2697.24) == 100


def test_step_for_six_figure_price():
    assert round_number_step(123456.78) == 10000


def test_step_for_three_figure_price():
    assert round_number_step(276.5) == 10


def test_nearest_round_numbers_btc():
    below, above = nearest_round_numbers(85761.80)
    assert below == 85000
    assert above == 86000


def test_nearest_round_numbers_eth():
    below, above = nearest_round_numbers(2697.24)
    assert below == 2600
    assert above == 2700


def test_price_exactly_on_a_round_number_steps_further_out():
    below, above = nearest_round_numbers(86000.0)
    assert below == 85000
    assert above == 87000


def test_zero_or_negative_price_raises():
    with pytest.raises(ValueError):
        round_number_step(0)
    with pytest.raises(ValueError):
        round_number_step(-100)
