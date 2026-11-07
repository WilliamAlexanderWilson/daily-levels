"""Public Coinbase Exchange candles for once-daily reaction research."""

from __future__ import annotations

import time

import pandas as pd
import requests

BASE_URL = "https://api.exchange.coinbase.com/products/{product}/candles"
GRANULARITY_SECONDS = 900
MAX_CANDLES = 300
REACTION_LOOKBACK_DAYS = 60
FORWARD_FETCH_DAYS = 63


def fetch_coinbase_15m(product: str, lookback_days: int = FORWARD_FETCH_DAYS) -> pd.DataFrame:
    # A candle timestamp is its start time. Exclude the bucket that is still
    # forming so an incomplete move can never enter the research artifact.
    end = pd.Timestamp.now(tz="UTC").floor("15min") - pd.Timedelta(minutes=15)
    start = end - pd.Timedelta(days=lookback_days)
    chunk = pd.Timedelta(seconds=GRANULARITY_SECONDS * (MAX_CANDLES - 1))
    rows: list[list[float]] = []
    cursor = start
    session = requests.Session()
    session.headers.update({"User-Agent": "daily-levels-session-research/1.0"})

    while cursor < end:
        chunk_end = min(cursor + chunk, end)
        last_error = None
        for attempt in range(3):
            try:
                response = session.get(
                    BASE_URL.format(product=product),
                    params={
                        "granularity": GRANULARITY_SECONDS,
                        "start": cursor.isoformat(),
                        "end": chunk_end.isoformat(),
                    },
                    timeout=20,
                )
                response.raise_for_status()
                payload = response.json()
                if not isinstance(payload, list):
                    raise ValueError(f"Coinbase returned an unexpected response for {product}: {payload}")
                rows.extend(payload)
                last_error = None
                break
            except (requests.RequestException, ValueError) as exc:
                last_error = exc
                if attempt < 2:
                    time.sleep(2 ** attempt)
        if last_error:
            raise last_error
        cursor = chunk_end + pd.Timedelta(seconds=GRANULARITY_SECONDS)

    if not rows:
        raise ValueError(f"Coinbase returned no candles for {product}")
    frame = pd.DataFrame(rows, columns=["time", "low", "high", "open", "close", "volume"])
    frame["time"] = pd.to_datetime(frame["time"], unit="s", utc=True)
    frame = frame.set_index("time")[["open", "high", "low", "close", "volume"]]
    frame = frame.astype(float).sort_index()
    return frame[~frame.index.duplicated(keep="last")]
