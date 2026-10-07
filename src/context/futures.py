"""Fetches Kraken Futures aggregate market context (open interest,
funding rate) server-side, once a day. Confirmed this specific endpoint
has no Access-Control-Allow-Origin header at all (checked the raw
response headers directly against a live request) - unlike every other
Kraken endpoint this project uses, it cannot be fetched live from the
browser, so it's baked into the once-a-day snapshot instead, fetched
here the same way the level engine fetches candles.

Unit gotcha that cost real time to track down: the ticker's `fundingRate`
and `fundingRatePrediction` fields are NOT percentages - per Kraken's own
docs, they're an absolute rate (BTC per $1 contract per hour). Mistaking
them for percentages would show a nonsensical ~60% "funding rate" instead
of the real ~0.0007%. `relativeFundingRate` / `relativeFundingRatePrediction`
are the fields exchanges actually display as "the funding rate" - verified
against a live response (relativeFundingRate was 7.09e-06, i.e. 0.0007%,
a sane figure; fundingRate was 0.5987, which is not a percentage of
anything meaningful). Kraken Futures pays funding hourly, not every 8h
like most exchanges, so these are hourly rates.
"""

import time

import requests

import config

KRAKEN_FUTURES_TICKERS_URL = "https://futures.kraken.com/derivatives/api/v3/tickers"

# Kraken Futures' perpetual symbol naming (PF_ = Perpetual Futures),
# confirmed live against the tickers endpoint.
FUTURES_SYMBOLS = {"btc": "PF_XBTUSD", "eth": "PF_ETHUSD"}


def fetch_futures_context(asset_key: str) -> dict | None:
    """Returns None (never raises) if the symbol is unknown or every
    retry fails - this is explicitly a "fail gracefully to unavailable"
    piece, not core to the pipeline the way the level engine is."""
    symbol = FUTURES_SYMBOLS.get(asset_key)
    if symbol is None:
        return None

    last_error: Exception | None = None
    for attempt in range(config.FETCH_RETRIES):
        try:
            response = requests.get(KRAKEN_FUTURES_TICKERS_URL, timeout=15)
            response.raise_for_status()
            payload = response.json()
            if payload.get("result") != "success":
                raise ValueError(f"Kraken Futures API error: {payload}")

            for ticker in payload.get("tickers", []):
                if ticker.get("symbol", "").upper() != symbol:
                    continue
                relative_rate = ticker.get("relativeFundingRate")
                relative_rate_prediction = ticker.get("relativeFundingRatePrediction")
                return {
                    "symbol": symbol,
                    "mark_price": ticker.get("markPrice"),
                    "open_interest": ticker.get("openInterest"),
                    "volume_24h": ticker.get("vol24h"),
                    "funding_rate_hourly_pct": relative_rate * 100 if relative_rate is not None else None,
                    "funding_rate_prediction_hourly_pct": (
                        relative_rate_prediction * 100 if relative_rate_prediction is not None else None
                    ),
                }
            raise ValueError(f"Symbol {symbol} not found in Kraken Futures tickers response")
        except Exception as exc:  # noqa: BLE001 - retry broadly, then fail gracefully to None
            last_error = exc
            if attempt < config.FETCH_RETRIES - 1:
                time.sleep(config.FETCH_BACKOFF_SECONDS * (2**attempt))

    print(f"WARNING: futures context fetch failed for {asset_key}: {last_error}")
    return None
