"""Simulates taking the ATM 2DTE SPY option described by the user on every
detected exhaustion signal, tracking the Black-Scholes-modeled premium
forward until it hits the +20% target, the -10% stop, or expiry - whichever
comes first. "2 DTE" is read as 2 TRADING days out (the SPY
0DTE/1DTE/2DTE convention), not 2 calendar days.

This is a premium-percentage backtest, not a dollar-PnL one: the strategy's
own rule (20% target / 10% stop) is already defined in option-premium
percentage terms, so contract count / sizing never has to be guessed.
"""

from dataclasses import dataclass

import pandas as pd

from src.spy.exhaustion_signal import Signal
from src.spy.options_pricing import black_scholes_price, nearest_vix_sigma, years_to_expiry

TARGET_PCT = 0.20
STOP_PCT = 0.10
DTE_TRADING_DAYS = 2
MARKET_OPEN = "09:30"
MARKET_CLOSE = "16:00"


@dataclass
class TradeResult:
    signal_time: pd.Timestamp
    direction: str
    n_confirmed: int
    confirmed_timeframes: list[int]
    entry_underlying: float
    strike: float
    expiry_date: object  # datetime.date
    entry_premium: float
    exit_time: pd.Timestamp
    exit_underlying: float
    exit_premium: float
    exit_reason: str  # "target", "stop", "expiry", or "incomplete" (ran off the data horizon)
    pct_return: float | None  # None only for "incomplete"


def _trading_days(real_5m: pd.DataFrame) -> list:
    local_dates = real_5m.index.tz_convert("America/New_York").date
    return sorted(set(local_dates))


def _regular_session(real_5m: pd.DataFrame) -> pd.DataFrame:
    local = real_5m.index.tz_convert("America/New_York")
    times = local.strftime("%H:%M")
    return real_5m[(times >= MARKET_OPEN) & (times <= MARKET_CLOSE)]


def _price_at_or_before(real_5m: pd.DataFrame, t: pd.Timestamp) -> float | None:
    prior = real_5m[real_5m.index <= t]
    if prior.empty:
        return None
    return float(prior["close"].iloc[-1])


def simulate_trade(
    signal: Signal,
    real_5m: pd.DataFrame,
    vix_daily: pd.Series,
    trading_days: list,
    target_pct: float = TARGET_PCT,
    stop_pct: float = STOP_PCT,
) -> TradeResult | None:
    session = _regular_session(real_5m)
    entry_underlying = _price_at_or_before(session, signal.time)
    if entry_underlying is None:
        return None

    entry_day = signal.time.tz_convert("America/New_York").date()
    if entry_day not in trading_days:
        return None
    entry_idx = trading_days.index(entry_day)
    expiry_idx = entry_idx + DTE_TRADING_DAYS
    is_call = signal.direction == "call"
    strike = round(entry_underlying)

    incomplete_shape = dict(
        signal_time=signal.time,
        direction=signal.direction,
        n_confirmed=signal.n_confirmed,
        confirmed_timeframes=signal.confirmed_timeframes,
        entry_underlying=entry_underlying,
        strike=float(strike),
    )

    if expiry_idx >= len(trading_days):
        return TradeResult(
            **incomplete_shape,
            expiry_date=None,
            entry_premium=float("nan"),
            exit_time=signal.time,
            exit_underlying=entry_underlying,
            exit_premium=float("nan"),
            exit_reason="incomplete",
            pct_return=None,
        )
    expiry_date = trading_days[expiry_idx]

    sigma = nearest_vix_sigma(vix_daily, signal.time)
    entry_t_years = years_to_expiry(signal.time, pd.Timestamp(expiry_date))
    entry_premium = black_scholes_price(entry_underlying, strike, entry_t_years, sigma, is_call)
    if entry_premium <= 0.01:
        # Too close to expiry / too deep an assumption breakdown to trust - skip rather
        # than divide by a near-zero premium and report a meaningless %.
        return None

    target_premium = entry_premium * (1 + target_pct)
    stop_premium = entry_premium * (1 - stop_pct)

    forward = session[(session.index > signal.time) & (session.index.tz_convert("America/New_York").date <= expiry_date)]

    for t, row in forward.iterrows():
        t_years = years_to_expiry(t, pd.Timestamp(expiry_date))
        sigma_t = nearest_vix_sigma(vix_daily, t)
        premium = black_scholes_price(float(row["close"]), strike, t_years, sigma_t, is_call)

        if premium >= target_premium:
            return TradeResult(
                **incomplete_shape,
                expiry_date=expiry_date,
                entry_premium=entry_premium,
                exit_time=t,
                exit_underlying=float(row["close"]),
                exit_premium=premium,
                exit_reason="target",
                pct_return=(premium - entry_premium) / entry_premium,
            )
        if premium <= stop_premium:
            return TradeResult(
                **incomplete_shape,
                expiry_date=expiry_date,
                entry_premium=entry_premium,
                exit_time=t,
                exit_underlying=float(row["close"]),
                exit_premium=premium,
                exit_reason="stop",
                pct_return=(premium - entry_premium) / entry_premium,
            )

    if len(forward) == 0:
        return None
    last_t, last_row = forward.index[-1], forward.iloc[-1]
    final_premium = black_scholes_price(
        float(last_row["close"]), strike, years_to_expiry(last_t, pd.Timestamp(expiry_date)),
        nearest_vix_sigma(vix_daily, last_t), is_call,
    )
    return TradeResult(
        **incomplete_shape,
        expiry_date=expiry_date,
        entry_premium=entry_premium,
        exit_time=last_t,
        exit_underlying=float(last_row["close"]),
        exit_premium=final_premium,
        exit_reason="expiry",
        pct_return=(final_premium - entry_premium) / entry_premium,
    )


def run_backtest(
    signals: list[Signal], real_5m: pd.DataFrame, vix_daily: pd.Series, min_confirmed: int = 1
) -> list[TradeResult]:
    trading_days = _trading_days(real_5m)
    filtered = [s for s in signals if s.n_confirmed >= min_confirmed]
    results = []
    for sig in filtered:
        trade = simulate_trade(sig, real_5m, vix_daily, trading_days)
        if trade is not None:
            results.append(trade)
    return results


def summarize(results: list[TradeResult]) -> dict:
    resolved = [r for r in results if r.pct_return is not None]
    incomplete = len(results) - len(resolved)
    if not resolved:
        return {"trades": len(results), "resolved": 0, "incomplete": incomplete}

    targets = sum(1 for r in resolved if r.exit_reason == "target")
    stops = sum(1 for r in resolved if r.exit_reason == "stop")
    expiries = sum(1 for r in resolved if r.exit_reason == "expiry")
    avg_return = sum(r.pct_return for r in resolved) / len(resolved)
    calls = sum(1 for r in resolved if r.direction == "call")
    puts = len(resolved) - calls

    return {
        "trades": len(results),
        "resolved": len(resolved),
        "incomplete": incomplete,
        "calls": calls,
        "puts": puts,
        "target_hits": targets,
        "stop_hits": stops,
        "expired_neither": expiries,
        "target_hit_rate_pct": round(100 * targets / len(resolved), 1),
        "stop_hit_rate_pct": round(100 * stops / len(resolved), 1),
        "avg_pct_return": round(100 * avg_return, 2),
    }
