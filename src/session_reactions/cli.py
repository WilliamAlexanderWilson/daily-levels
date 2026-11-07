"""Refresh BTC/ETH market-open reaction artifacts at most once per day."""

from __future__ import annotations

import argparse
import json
import os

import pandas as pd

import config
from src.output import atomic_write_json
from src.session_reactions.coinbase import FORWARD_FETCH_DAYS, REACTION_LOOKBACK_DAYS, fetch_coinbase_15m
from src.session_reactions.engine import build_reaction_payload
from src.session_reactions.forward import update_forward_payload

SOURCE_URL = "https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles"
ASSETS = {"btc": "BTC-USD", "eth": "ETH-USD"}


def _is_fresh(path: str, max_age_hours: int) -> bool:
    if not os.path.exists(path):
        return False


def _load_json(path: str) -> dict | None:
    if not os.path.exists(path):
        return None
    try:
        with open(path) as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError):
        return None
    try:
        with open(path) as handle:
            generated = pd.Timestamp(json.load(handle)["generated_at_utc"])
        if generated.tzinfo is None:
            generated = generated.tz_localize("UTC")
        return pd.Timestamp.now(tz="UTC") - generated < pd.Timedelta(hours=max_age_hours)
    except (KeyError, ValueError, TypeError, json.JSONDecodeError):
        return False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--max-age-hours", type=int, default=20)
    args = parser.parse_args()
    for asset, product in ASSETS.items():
        path = f"{config.DATA_DIR}/{asset}_session_reactions.json"
        forward_path = f"{config.DATA_DIR}/{asset}_range_open_forward.json"
        if not args.force and _is_fresh(path, args.max_age_hours) and _is_fresh(forward_path, args.max_age_hours):
            print(f"{asset.upper()}: reaction research is still fresh; skipping")
            continue
        print(f"{asset.upper()}: fetching {FORWARD_FETCH_DAYS}d of Coinbase 15m candles...")
        candles = fetch_coinbase_15m(product)
        reaction_cutoff = candles.index.max() - pd.Timedelta(days=REACTION_LOOKBACK_DAYS)
        reaction_candles = candles[candles.index >= reaction_cutoff]
        payload = build_reaction_payload(
            asset,
            reaction_candles,
            15,
            "Coinbase Exchange BTC-USD/ETH-USD candles",
            SOURCE_URL,
            "Public Coinbase Exchange trades; this is one venue, not a consolidated crypto market.",
        )
        atomic_write_json(path, payload)
        forward_payload = update_forward_payload(
            asset,
            candles,
            15,
            payload["source"],
            _load_json(forward_path),
        )
        atomic_write_json(forward_path, forward_payload)
        print(f"  wrote {path} and {forward_path} from {len(candles):,} candles")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
