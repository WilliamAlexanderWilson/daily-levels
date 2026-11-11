"""Export a two-year XAU gold benchmark archive from Kraken Futures charts.

The public chart is the PF_XAUTUSD spot-index series. It is useful price
context, but it is not represented as an executable interbank XAU/USD quote.
The endpoint caps each response, so this exporter pages forward until the
complete configured window is present.
"""

from __future__ import annotations

import time

import pandas as pd
import requests

import config
from src.chart_archive import write_monthly_archive
from src.output import atomic_write_json

CHART_URL = "https://futures.kraken.com/api/charts/v1/spot/PF_XAUTUSD/15m"
HISTORY_DAYS = 730
TIMEFRAMES = (15, 30, 60, 240)
CHART_DISPLAY_DAYS = 60


def _request_page(start_unix: int, end_unix: int) -> dict:
    response = requests.get(CHART_URL, params={"from": start_unix, "to": end_unix}, timeout=30)
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload.get("candles"), list):
        raise ValueError("Kraken XAU chart response did not contain candles")
    return payload


def fetch_xau_15m(now: pd.Timestamp | None = None) -> pd.DataFrame:
    end = pd.Timestamp.now(tz="UTC") if now is None else pd.Timestamp(now)
    if end.tzinfo is None:
        end = end.tz_localize("UTC")
    else:
        end = end.tz_convert("UTC")
    start = end - pd.Timedelta(days=HISTORY_DAYS)
    start_unix = int(start.timestamp())
    end_unix = int(end.timestamp())
    cursor = start_unix
    rows_by_time: dict[int, dict] = {}

    while cursor < end_unix:
        payload = _request_page(cursor, end_unix)
        rows = payload["candles"]
        if not rows:
            break
        for row in rows:
            timestamp = int(row["time"] // 1000)
            if timestamp >= start_unix:
                rows_by_time[timestamp] = row
        latest = max(int(row["time"] // 1000) for row in rows)
        if latest < cursor:
            raise RuntimeError("Kraken XAU pagination did not move forward")
        cursor = latest + 1
        if not payload.get("more_candles"):
            break
        time.sleep(0.05)

    records = [
        {
            "time": pd.to_datetime(timestamp, unit="s", utc=True),
            "open": float(row["open"]),
            "high": float(row["high"]),
            "low": float(row["low"]),
            "close": float(row["close"]),
            "volume": float(row.get("volume") or 0),
        }
        for timestamp, row in sorted(rows_by_time.items())
    ]
    if not records:
        raise RuntimeError("Kraken returned no XAU benchmark candles")
    frame = pd.DataFrame(records).set_index("time").sort_index()
    completed_before = end.floor("15min")
    return frame[frame.index < completed_before]


def _resample(frame: pd.DataFrame, minutes: int) -> pd.DataFrame:
    if minutes == 15:
        return frame
    resampled = frame.resample(f"{minutes}min", origin="epoch", label="left", closed="left").agg(
        {"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"}
    ).dropna(subset=["open", "high", "low", "close"])
    completed_through = frame.index.max() + pd.Timedelta(minutes=15)
    return resampled[resampled.index + pd.Timedelta(minutes=minutes) <= completed_through]


def _rows(frame: pd.DataFrame) -> list[dict]:
    return [
        {
            "time": int(timestamp.timestamp()),
            "open": float(row.open),
            "high": float(row.high),
            "low": float(row.low),
            "close": float(row.close),
        }
        for timestamp, row in frame.iterrows()
    ]


def _range_context(frame: pd.DataFrame, price: float, generated_at: pd.Timestamp) -> dict:
    completed = frame[frame.index < generated_at.floor("D")]
    daily = completed.resample("1D").agg({"high": "max", "low": "min"}).dropna()
    window = daily.tail(20)
    if len(window) < 20:
        return {"available": False, "method": "Prior 20 completed UTC days", "is_signal": False}
    low = float(window.low.min())
    high = float(window.high.max())
    width = high - low
    if width <= 0:
        return {"available": False, "method": "Prior 20 completed UTC days", "is_signal": False}
    midpoint = (high + low) / 2
    return {
        "available": width > 0,
        "method": "Prior 20 completed UTC days",
        "lookback_sessions": 20,
        "edge_fraction": 0.15,
        "window_start": window.index[0].date().isoformat(),
        "window_end": window.index[-1].date().isoformat(),
        "high": high,
        "upper_edge_min": high - width * 0.15,
        "midpoint": midpoint,
        "lower_edge_max": low + width * 0.15,
        "low": low,
        "width": width,
        "width_pct": width / midpoint * 100,
        "position_pct": (price - low) / width * 100,
        "state": "context_only",
        "is_signal": False,
        "session_scope": "24-hour Kraken PF_XAUTUSD spot-index benchmark",
        "source_limit": "Delayed batch benchmark; not an executable interbank XAU/USD quote",
    }


def build_payload(frame: pd.DataFrame, generated_at: pd.Timestamp) -> dict:
    price = float(frame.close.iloc[-1])
    cutoff = frame.index.max() - pd.Timedelta(days=CHART_DISPLAY_DAYS)
    return {
        "generated_at_utc": generated_at.isoformat(),
        "price": price,
        "symbol": "XAU",
        "source": "Kraken Futures PF_XAUTUSD spot-index chart",
        "is_live": False,
        "range_context": _range_context(frame, price, generated_at),
        "timeframes": {
            str(minutes): _rows(_resample(frame, minutes)[lambda rows: rows.index >= cutoff])
            for minutes in TIMEFRAMES
        },
    }


def main() -> int:
    generated_at = pd.Timestamp.now(tz="UTC")
    frame = fetch_xau_15m(generated_at)
    payload = build_payload(frame, generated_at)
    atomic_write_json(f"{config.DATA_DIR}/xau_chart.json", payload)
    write_monthly_archive(
        "xau",
        {str(minutes): _rows(_resample(frame, minutes)) for minutes in TIMEFRAMES},
        payload["source"],
    )
    print(f"wrote XAU chart with {len(frame)} completed 15m benchmark bars")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
