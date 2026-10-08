"""Hand-verifiable Black-Scholes checks against known reference values
(Hull's textbook example: S=100, K=100, T=1y, r=5%, sigma=20%, q=0 ->
call ~= 10.4506, and put via put-call parity P = C - S + K*e^(-rT) ~= 5.5735).
"""

import math

import pandas as pd
import pytest

from src.spy.options_pricing import black_scholes_price, nearest_vix_sigma, years_to_expiry


def test_known_call_price():
    price = black_scholes_price(S=100, K=100, T=1.0, sigma=0.20, is_call=True, r=0.05, q=0.0)
    assert price == pytest.approx(10.4506, abs=0.001)


def test_known_put_price_via_parity():
    call = 10.4506
    expected_put = call - 100 + 100 * math.exp(-0.05 * 1.0)
    price = black_scholes_price(S=100, K=100, T=1.0, sigma=0.20, is_call=False, r=0.05, q=0.0)
    assert price == pytest.approx(expected_put, abs=0.001)


def test_at_expiry_is_intrinsic_value():
    assert black_scholes_price(S=105, K=100, T=0, sigma=0.20, is_call=True) == 5.0
    assert black_scholes_price(S=95, K=100, T=0, sigma=0.20, is_call=True) == 0.0
    assert black_scholes_price(S=95, K=100, T=0, sigma=0.20, is_call=False) == 5.0


def test_years_to_expiry_hand_computed():
    # 16:00 America/New_York on 2026-08-07 (EDT, UTC-4) = 20:00 UTC.
    as_of = pd.Timestamp("2026-08-05 20:00:00", tz="UTC")
    expiry_date = pd.Timestamp("2026-08-07")
    expected_seconds = 2 * 24 * 3600  # exactly 2 days from as_of to that close
    expected_years = expected_seconds / (365 * 24 * 3600)
    assert years_to_expiry(as_of, expiry_date) == pytest.approx(expected_years, abs=1e-9)


def test_years_to_expiry_floors_at_zero_past_expiry():
    as_of = pd.Timestamp("2026-08-10 20:00:00", tz="UTC")
    expiry_date = pd.Timestamp("2026-08-07")
    assert years_to_expiry(as_of, expiry_date) == 0.0


def test_nearest_vix_sigma_picks_most_recent_prior_close():
    vix = pd.Series(
        [15.0, 20.0, 25.0],
        index=pd.to_datetime(["2026-08-03", "2026-08-04", "2026-08-05"], utc=True),
    )
    as_of = pd.Timestamp("2026-08-04 15:00:00", tz="UTC")
    assert nearest_vix_sigma(vix, as_of) == pytest.approx(0.20)
