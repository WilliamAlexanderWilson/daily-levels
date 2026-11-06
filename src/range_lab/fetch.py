"""Fetch deep, public 4-hour BTC perpetual-futures candles from Kraken.

Kraken spot OHLC is capped at 720 rows. The public futures chart endpoint
supports bounded historical windows, which makes a multi-regime holdout test
possible without credentials.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pandas as pd
import requests

BASE_URL = "https://futures.kraken.com/api/charts/v1/trade/PF_XBTUSD/4h"
HISTORY_START = datetime(2022, 3, 23, tzinfo=timezone.utc)
WINDOW_DAYS = 180


def _parse_candles(payload: dict) -> pd.DataFrame:
    rows = payload.get("candles")
    if not isinstance(rows, list):
        raise ValueError("Kraken futures response is missing candles")
    if not rows:
        return pd.DataFrame(columns=["open", "high", "low", "close", "volume"])

    frame = pd.DataFrame(rows)
    required = ["time", "open", "high", "low", "close", "volume"]
    missing = [column for column in required if column not in frame]
    if missing:
        raise ValueError(f"Kraken futures response is missing {missing}")
    frame["time"] = pd.to_datetime(frame["time"], unit="ms", utc=True)
    for column in required[1:]:
        frame[column] = pd.to_numeric(frame[column], errors="raise")
    return frame.set_index("time")[required[1:]].sort_index()


def fetch_btc_4h(
    start: datetime = HISTORY_START,
    end: datetime | None = None,
    session: requests.Session | None = None,
) -> pd.DataFrame:
    """Return deduplicated, completed 4-hour candles over ``start..end``.

    Requests are intentionally split into six-month windows so a response-size
    cap cannot silently turn a multi-year request into recent-only history.
    """
    end = end or datetime.now(timezone.utc)
    if start.tzinfo is None or end.tzinfo is None:
        raise ValueError("start and end must be timezone-aware")
    if end <= start:
        raise ValueError("end must be after start")

    client = session or requests.Session()
    pages: list[pd.DataFrame] = []
    cursor = start
    while cursor < end:
        window_end = min(cursor + timedelta(days=WINDOW_DAYS), end)
        response = client.get(
            BASE_URL,
            params={"from": int(cursor.timestamp()), "to": int(window_end.timestamp())},
            timeout=30,
        )
        response.raise_for_status()
        page = _parse_candles(response.json())
        if not page.empty:
            pages.append(page)
        cursor = window_end

    if not pages:
        raise RuntimeError("Kraken returned no BTC 4-hour candles")
    candles = pd.concat(pages).sort_index()
    candles = candles[~candles.index.duplicated(keep="last")]

    # Exclude an unfinished current 4-hour bar. A candle is completed only
    # after its opening timestamp plus four hours is in the past.
    completed_before = pd.Timestamp(end) - pd.Timedelta(hours=4)
    candles = candles[candles.index <= completed_before]
    if candles.empty:
        raise RuntimeError("Kraken returned no completed BTC 4-hour candles")
    return candles

