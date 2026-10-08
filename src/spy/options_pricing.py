"""Black-Scholes pricing used to APPROXIMATE the ATM 2DTE SPY option's
value from the underlying's real price path. This is a model, not real
historical bid/ask quotes - no free source for those exists. It's the
backtest's single biggest source of error versus live fills (real SPY
options trade with their own supply/demand skew, not textbook BS), and is
reported as such everywhere these results are shown.

Inputs:
  S     underlying price (real, not Heikin-Ashi)
  K     strike - ATM at entry means K = round(S) at the moment of entry
  T     time to expiration, in years, by actual calendar time remaining
        (not trading-time) - theta burns through nights and weekends too
  r     risk-free rate, config constant (not fetched live)
  q     SPY's dividend yield, config constant
  sigma annualized IV - VIX/100 on the entry day, used as a proxy for
        SPY's own short-dated ATM IV (no free source for the real number)
"""

import math

import pandas as pd

RISK_FREE_RATE = 0.05
DIVIDEND_YIELD = 0.013
MARKET_CLOSE_LOCAL = "16:00"


def _norm_cdf(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def black_scholes_price(S: float, K: float, T: float, sigma: float, is_call: bool,
                         r: float = RISK_FREE_RATE, q: float = DIVIDEND_YIELD) -> float:
    """European option price. At or past expiry (T <= 0) returns intrinsic
    value. SPY options are American-style but intrinsic-at-expiry and
    BS-before-expiry is the standard practical approximation for ATM-ish
    short-dated options, where early exercise premium is negligible."""
    if T <= 0:
        return max(S - K, 0.0) if is_call else max(K - S, 0.0)
    if sigma <= 0:
        forward = S * math.exp((r - q) * T)
        intrinsic_fwd = max(forward - K, 0.0) if is_call else max(K - forward, 0.0)
        return intrinsic_fwd * math.exp(-r * T)

    sqrt_t = math.sqrt(T)
    d1 = (math.log(S / K) + (r - q + sigma**2 / 2) * T) / (sigma * sqrt_t)
    d2 = d1 - sigma * sqrt_t

    if is_call:
        return S * math.exp(-q * T) * _norm_cdf(d1) - K * math.exp(-r * T) * _norm_cdf(d2)
    return K * math.exp(-r * T) * _norm_cdf(-d2) - S * math.exp(-q * T) * _norm_cdf(-d1)


def years_to_expiry(as_of: pd.Timestamp, expiry_date: pd.Timestamp) -> float:
    """Calendar-time (not trading-time) years between `as_of` and 16:00
    America/New_York on `expiry_date`."""
    expiry_close = pd.Timestamp(
        f"{expiry_date.date()} {MARKET_CLOSE_LOCAL}", tz="America/New_York"
    ).tz_convert("UTC")
    seconds = (expiry_close - as_of).total_seconds()
    return max(seconds, 0.0) / (365 * 24 * 3600)


def nearest_vix_sigma(vix_daily: pd.Series, as_of: pd.Timestamp) -> float:
    """VIX close on (or most recently before) as_of's date, as a decimal."""
    as_of_date = as_of.normalize()
    prior = vix_daily[vix_daily.index <= as_of_date]
    if prior.empty:
        prior = vix_daily
    return float(prior.iloc[-1]) / 100
