"""SPY/VIX access for the exhaustion-reversal backtest. Separate from
src/fetch.py on purpose - that file is Kraken-only (crypto), and SPY needs
its own sources entirely.

Two sources, for two different jobs:
  - Alpaca (data.alpaca.markets) for genuine 1-minute SPY chart bars and
    the separate 5-minute bars the signal detection and backtest run on.
    Needs a free API key (see ALPACA_API_KEY/ALPACA_SECRET_KEY below) but,
    currently gives real bars back to July 2020 on the free IEX feed
    (checked 2026-11-11) - genuinely paginated via next_page_token, not
    truncated to a rolling window the way Yahoo's free endpoint is. This fixes the
    60-day sample-size ceiling the first version of this backtest shipped
    with.
  - Yahoo Finance's public chart endpoint for VIX, still - no key, and
    daily-interval history has no short rolling-window cap the way Yahoo's
    own INTRADAY data does (that cap is what pushed SPY's own bars to
    Alpaca in the first place; VIX is only ever needed at daily
    resolution, so Yahoo remains the simpler free source for it).
"""

import os

import pandas as pd
import requests

YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
HEADERS = {"User-Agent": "Mozilla/5.0"}  # Yahoo blocks requests with no User-Agent
YAHOO_MAX_INTRADAY_RANGE_DAYS = 60  # confirmed live: Yahoo's own 5m candles are truncated beyond this

ALPACA_BARS_URL = "https://data.alpaca.markets/v2/stocks/{symbol}/bars"
ALPACA_PAGE_LIMIT = 10000
ALPACA_HISTORY_DAYS = 730  # ~2 years - real sample size for the backtest, free IEX feed goes back further still


def _load_dotenv(path: str = ".env") -> None:
    """Minimal .env loader - avoids adding python-dotenv as a dependency
    for one file. Never overwrites a variable already set in the real
    environment (e.g. by CI secrets)."""
    if not os.path.exists(path):
        return
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())


_load_dotenv()


def _fetch_chart(symbol: str, interval: str, range_: str) -> dict:
    url = YAHOO_CHART_URL.format(symbol=symbol)
    response = requests.get(
        url, params={"interval": interval, "range": range_}, headers=HEADERS, timeout=15
    )
    response.raise_for_status()
    payload = response.json()
    result = payload.get("chart", {}).get("result")
    if not result:
        error = payload.get("chart", {}).get("error")
        raise ValueError(f"Yahoo chart API error for {symbol}: {error}")
    return result[0]


def fetch_vix_daily(range_days: int = ALPACA_HISTORY_DAYS) -> pd.Series:
    """Daily VIX close, indexed by UTC date (midnight). Used as a free proxy
    for SPY's short-dated ATM implied vol - not SPY's own options-chain IV,
    which isn't available without a paid data source. See
    src/spy/options_pricing.py for how this feeds the model. Defaults to
    the same window as the Alpaca SPY fetch below, so every signal in that
    window has a same-day VIX close to price against."""
    result = _fetch_chart("^VIX", interval="1d", range_=f"{range_days}d")
    timestamps = result["timestamp"]
    closes = result["indicators"]["quote"][0]["close"]

    series = pd.Series(
        closes, index=pd.to_datetime(timestamps, unit="s", utc=True).normalize(), name="vix_close"
    )
    return series.dropna().sort_index()


def _alpaca_headers() -> dict:
    api_key = os.environ.get("ALPACA_API_KEY")
    secret_key = os.environ.get("ALPACA_SECRET_KEY")
    if not api_key or not secret_key:
        raise RuntimeError(
            "ALPACA_API_KEY / ALPACA_SECRET_KEY not set - expected in a local .env file "
            "(gitignored) or as real environment variables in CI."
        )
    return {"APCA-API-KEY-ID": api_key, "APCA-API-SECRET-KEY": secret_key}


def fetch_alpaca_window(
    symbol: str, minutes: int, start: pd.Timestamp, end: pd.Timestamp
) -> pd.DataFrame:
    """Fetch every available IEX bar in an explicit UTC window, with pagination."""
    if minutes not in (1, 5):
        raise ValueError("Alpaca source interval must be 1 or 5 minutes")
    start = pd.Timestamp(start)
    end = pd.Timestamp(end)
    if start.tzinfo is None or end.tzinfo is None or start >= end:
        raise ValueError("Alpaca window needs timezone-aware start before end")
    headers = _alpaca_headers()
    url = ALPACA_BARS_URL.format(symbol=symbol)

    all_bars = []
    page_token = None
    seen_tokens = set()
    while True:
        params = {
            "timeframe": f"{minutes}Min",
            "start": start.isoformat(),
            "end": end.isoformat(),
            "limit": ALPACA_PAGE_LIMIT,
            "adjustment": "raw",
            # Free accounts get the IEX feed, not SIP - and without this
            # explicit, Alpaca defaults to SIP and 403s with "subscription
            # does not permit querying recent SIP data" the moment the
            # requested range gets close to now (confirmed live: the exact
            # same call succeeds for an all-past range and fails only once
            # `end` approaches the present).
            "feed": "iex",
        }
        if page_token:
            params["page_token"] = page_token

        response = requests.get(url, params=params, headers=headers, timeout=30)
        response.raise_for_status()
        payload = response.json()
        all_bars.extend(payload.get("bars") or [])

        page_token = payload.get("next_page_token")
        if not page_token:
            break
        if page_token in seen_tokens:
            raise RuntimeError(f"Alpaca repeated a page token for {symbol} {minutes}m")
        seen_tokens.add(page_token)

    if not all_bars:
        raise ValueError(f"Alpaca returned no {minutes}m IEX bars for {symbol} in {start} to {end}")

    df = pd.DataFrame(all_bars).rename(
        columns={"t": "time", "o": "open", "h": "high", "l": "low", "c": "close", "v": "volume"}
    )
    df["time"] = pd.to_datetime(df["time"], utc=True)
    return df.set_index("time")[["open", "high", "low", "close", "volume"]].sort_index()


def _fetch_alpaca_intraday(symbol: str, minutes: int, days: int) -> pd.DataFrame:
    """Real Alpaca IEX OHLCV bars over the last `days` calendar days."""
    end = pd.Timestamp.now(tz="UTC")
    return fetch_alpaca_window(symbol, minutes, end - pd.Timedelta(days=days), end)


def fetch_alpaca_1m(symbol: str = "SPY", days: int = ALPACA_HISTORY_DAYS) -> pd.DataFrame:
    """Genuine one-minute IEX bars for the SPY chart, never synthesized from 5m."""
    return _fetch_alpaca_intraday(symbol, 1, days)


def fetch_alpaca_5m(symbol: str = "SPY", days: int = ALPACA_HISTORY_DAYS) -> pd.DataFrame:
    """Five-minute IEX bars for the existing SPY research and equity exports."""
    return _fetch_alpaca_intraday(symbol, 5, days)
