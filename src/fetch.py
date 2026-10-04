"""Exchange access. Every other module gets candles through fetch_candles();
nothing outside this file knows the data source is Kraken."""

import time

import pandas as pd
import requests

from config import FETCH_BACKOFF_SECONDS, FETCH_RETRIES, KRAKEN_BASE_URL

COLUMNS = ["time", "open", "high", "low", "close", "vwap", "volume", "count"]
NUMERIC_COLUMNS = ["open", "high", "low", "close", "vwap", "volume"]


def _parse_response(payload: dict, symbol: str) -> pd.DataFrame:
    """Turns a raw Kraken OHLC JSON payload into a DataFrame indexed by UTC
    timestamp, with the still-forming last candle dropped. Pulled out of
    fetch_candles so tests can replay a saved real response without a
    network call."""
    if payload.get("error"):
        raise ValueError(f"Kraken API error for {symbol}: {payload['error']}")
    rows = payload["result"][symbol]

    df = pd.DataFrame(rows, columns=COLUMNS)
    df["time"] = pd.to_datetime(df["time"], unit="s", utc=True)
    df[NUMERIC_COLUMNS] = df[NUMERIC_COLUMNS].astype(float)
    df["count"] = df["count"].astype(int)
    df = df.set_index("time").sort_index()

    # The last row is the current, not-yet-committed candle. Drop it so we
    # only ever report on fully closed candles.
    df = df.iloc[:-1]

    return df


def fetch_candles(symbol: str, interval: int) -> pd.DataFrame:
    """Fetch OHLC candles for a Kraken pair (e.g. "BTC/USD").

    Returns a DataFrame indexed by UTC timestamp with columns open, high,
    low, close, vwap, volume, count. The still-forming last candle is
    dropped. Raises RuntimeError if all retries fail.
    """
    params = {"pair": symbol, "interval": interval, "assetVersion": 1}

    last_error: Exception | None = None
    for attempt in range(FETCH_RETRIES):
        try:
            response = requests.get(KRAKEN_BASE_URL, params=params, timeout=15)
            response.raise_for_status()
            return _parse_response(response.json(), symbol)
        except Exception as exc:  # noqa: BLE001 - we retry broadly, then raise
            last_error = exc
            if attempt < FETCH_RETRIES - 1:
                time.sleep(FETCH_BACKOFF_SECONDS * (2**attempt))

    raise RuntimeError(
        f"fetch_candles({symbol!r}, {interval}) failed after {FETCH_RETRIES} attempts"
    ) from last_error
