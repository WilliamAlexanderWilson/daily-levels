"""Entry point: run the level engine for every configured asset and write
site/data. Invoked by the GitHub Action cron, or manually.

    python -m src.run            # only runs during the 5am Central hour
    python -m src.run --force    # runs regardless of local time (workflow_dispatch)
"""

import argparse

import pandas as pd

import config
from src.levels.engine import build_asset_levels
from src.output import write_asset_outputs


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--force",
        action="store_true",
        help="skip the 5am-local-hour gate (used for manual/workflow_dispatch runs)",
    )
    args = parser.parse_args()

    now_local = pd.Timestamp.now(tz=config.LOCAL_TIMEZONE)
    if not args.force and now_local.hour != config.RUN_HOUR_LOCAL:
        print(
            f"Not the {config.RUN_HOUR_LOCAL}am {config.LOCAL_TIMEZONE} hour "
            f"(it's {now_local.hour}:00 local) — exiting without running."
        )
        return 0

    exit_code = 0
    for asset_key, pair in config.ASSETS.items():
        try:
            print(f"Running engine for {asset_key} ({pair})...")
            engine_result = build_asset_levels(pair)
            write_asset_outputs(asset_key, engine_result)
            n_levels = len(engine_result["result"]["levels"])
            price = engine_result["result"]["price"]
            print(f"  price={price}  levels={n_levels}")
        except Exception as exc:  # noqa: BLE001 - keep yesterday's files, don't crash the other asset
            print(f"  FAILED for {asset_key}: {exc}")
            exit_code = 1

    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
