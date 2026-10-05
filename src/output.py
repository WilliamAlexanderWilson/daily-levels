"""Writes engine results to site/data as JSON. Every write is atomic
(write to a temp file, then rename) so a crash mid-write can never leave a
partial file behind — if a run fails before this point, the previous
day's files are simply never touched."""

import json
import os

import pandas as pd

from config import DATA_DIR, HISTORY_DIR
from src.levels.daily_diff import compute_diff


def atomic_write_json(path: str, data: dict | list) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp_path = f"{path}.tmp"
    with open(tmp_path, "w") as f:
        json.dump(data, f, indent=2, default=str)
    os.replace(tmp_path, path)


def load_previous_snapshot(asset_key: str, before_date: str) -> dict | None:
    """The most recent history snapshot strictly before before_date (an
    ISO "YYYY-MM-DD" string), or None if there isn't one (first run ever,
    or every prior run failed before writing history). Looks for the
    latest prior date rather than exactly "yesterday" so a missed run
    doesn't break the diff - it just compares against the last good day.
    """
    history_dir = f"{HISTORY_DIR}/{asset_key}"
    if not os.path.isdir(history_dir):
        return None

    prior_dates = sorted(
        fname[: -len(".json")]
        for fname in os.listdir(history_dir)
        if fname.endswith(".json") and fname[: -len(".json")] < before_date
    )
    if not prior_dates:
        return None

    with open(f"{history_dir}/{prior_dates[-1]}.json") as f:
        return json.load(f)


def _candles_to_json(candles: pd.DataFrame) -> list[dict]:
    return [
        {
            "time": int(ts.timestamp()),
            "open": row["open"],
            "high": row["high"],
            "low": row["low"],
            "close": row["close"],
            "volume": row["volume"],
        }
        for ts, row in candles.iterrows()
    ]


def write_asset_outputs(asset_key: str, engine_result: dict) -> None:
    """asset_key is "btc" or "eth". engine_result is the dict returned by
    build_asset_levels: {"result": ..., "candles_4h": ..., "candles_1d": ...}."""
    result = engine_result["result"]

    today = result["generated_at_central"][:10]
    previous = load_previous_snapshot(asset_key, today)
    previous_levels = previous["levels"] if previous else None
    result["diff"] = compute_diff(result["levels"], previous_levels)

    atomic_write_json(f"{DATA_DIR}/{asset_key}_levels.json", result)
    atomic_write_json(
        f"{DATA_DIR}/{asset_key}_candles_4h.json",
        _candles_to_json(engine_result["candles_4h"]),
    )
    atomic_write_json(
        f"{DATA_DIR}/{asset_key}_candles_1d.json",
        _candles_to_json(engine_result["candles_1d"]),
    )

    atomic_write_json(f"{HISTORY_DIR}/{asset_key}/{today}.json", result)
