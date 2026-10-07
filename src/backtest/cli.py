"""Entry point: run the backtest scorecard and round-number proximity
curve for every configured asset, writing site/data/{asset}_scorecard.json
and site/data/{asset}_round_proximity.json.

    python -m src.backtest.cli
"""

import config
from src.backtest.replay import replay_levels
from src.backtest.round_proximity import build_proximity_curve
from src.backtest.scorecard import build_scorecard
from src.fetch import fetch_candles
from src.output import atomic_write_json


def main() -> int:
    exit_code = 0
    for asset_key, pair in config.ASSETS.items():
        try:
            print(f"Backtesting {asset_key} ({pair})...")
            candles_1d = fetch_candles(pair, config.INTERVAL_1D)
            snapshots = replay_levels(candles_1d)

            scorecard = build_scorecard(snapshots, candles_1d)
            atomic_write_json(f"{config.DATA_DIR}/{asset_key}_scorecard.json", scorecard)
            total_touches = sum(v["touches"] for v in scorecard.values())
            print(f"  {len(scorecard)} level types, {total_touches} total touches")

            proximity = build_proximity_curve(snapshots, candles_1d)
            atomic_write_json(f"{config.DATA_DIR}/{asset_key}_round_proximity.json", proximity)
            print(f"  round-number proximity curve: {len(proximity)} tiers")
        except Exception as exc:  # noqa: BLE001 - keep yesterday's data, don't crash the other asset
            print(f"  FAILED for {asset_key}: {exc}")
            exit_code = 1
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
