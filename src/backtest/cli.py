"""Entry point: run the backtest scorecard for every configured asset and
write site/data/{asset}_scorecard.json.

    python -m src.backtest.cli
"""

import config
from src.backtest.replay import replay_levels
from src.backtest.scorecard import build_scorecard
from src.fetch import fetch_candles
from src.output import atomic_write_json


def run_for_asset(pair: str) -> dict:
    candles_1d = fetch_candles(pair, config.INTERVAL_1D)
    snapshots = replay_levels(candles_1d)
    return build_scorecard(snapshots, candles_1d)


def main() -> int:
    exit_code = 0
    for asset_key, pair in config.ASSETS.items():
        try:
            print(f"Backtesting {asset_key} ({pair})...")
            scorecard = run_for_asset(pair)
            atomic_write_json(f"{config.DATA_DIR}/{asset_key}_scorecard.json", scorecard)
            total_touches = sum(v["touches"] for v in scorecard.values())
            print(f"  {len(scorecard)} level types, {total_touches} total touches")
        except Exception as exc:  # noqa: BLE001 - keep yesterday's scorecard, don't crash the other asset
            print(f"  FAILED for {asset_key}: {exc}")
            exit_code = 1
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
