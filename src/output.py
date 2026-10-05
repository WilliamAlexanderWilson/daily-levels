"""Writes engine results to site/data as JSON. Every write is atomic
(write to a temp file, then rename) so a crash mid-write can never leave a
partial file behind — if a run fails before this point, the previous
day's files are simply never touched."""

import json
import os

import pandas as pd

from config import DATA_DIR, HISTORY_DIR


def atomic_write_json(path: str, data: dict | list) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp_path = f"{path}.tmp"
    with open(tmp_path, "w") as f:
        json.dump(data, f, indent=2, default=str)
    os.replace(tmp_path, path)


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

    atomic_write_json(f"{DATA_DIR}/{asset_key}_levels.json", result)
    atomic_write_json(
        f"{DATA_DIR}/{asset_key}_candles_4h.json",
        _candles_to_json(engine_result["candles_4h"]),
    )
    atomic_write_json(
        f"{DATA_DIR}/{asset_key}_candles_1d.json",
        _candles_to_json(engine_result["candles_1d"]),
    )

    today = result["generated_at_central"][:10]
    atomic_write_json(f"{HISTORY_DIR}/{asset_key}/{today}.json", result)
