"""Refresh BTC/ETH market-open reaction artifacts at most once per day."""

from __future__ import annotations

import argparse
import json
import os

import pandas as pd

import config
from src.output import atomic_write_json
from src.session_reactions.coinbase import LOOKBACK_DAYS, fetch_coinbase_15m
from src.session_reactions.engine import build_reaction_payload

SOURCE_URL = "https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles"
ASSETS = {"btc": "BTC-USD", "eth": "ETH-USD"}


def _is_fresh(path: str, max_age_hours: int) -> bool:
    if not os.path.exists(path):
        return False
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
        if not args.force and _is_fresh(path, args.max_age_hours):
            print(f"{asset.upper()}: reaction research is still fresh; skipping")
            continue
        print(f"{asset.upper()}: fetching {LOOKBACK_DAYS}d of Coinbase 15m candles...")
        candles = fetch_coinbase_15m(product)
        payload = build_reaction_payload(
            asset,
            candles,
            15,
            "Coinbase Exchange BTC-USD/ETH-USD candles",
            SOURCE_URL,
            "Public Coinbase Exchange trades; this is one venue, not a consolidated crypto market.",
        )
        atomic_write_json(path, payload)
        print(f"  wrote {path} from {len(candles):,} candles")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
