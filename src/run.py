"""Entry point: run the level engine for every configured asset and write
site/data. Invoked by the GitHub Action cron, or manually.

    python -m src.run            # skips an asset if it already ran today
    python -m src.run --force    # runs regardless (used for workflow_dispatch)

Gating is "has this asset already produced today's data," not "is it
currently the 5am hour" - GitHub's scheduled-workflow cron is best-effort
and has been observed firing 6-9 hours late for this repo. An hour-equality
check means a late firing checks the clock, sees it's no longer 5am, and
skips - forever, every day, no matter how many scheduled firings happen,
because none of them land in exactly the right hour. Checking "already ran
today" instead means whichever firing lands first each day (whatever hour
that turns out to be) does the real work, and is self-healing if a whole
day's firings get skipped entirely - the next one just runs.
"""

import argparse
import json
import os

import pandas as pd

import config
from src.levels.engine import build_asset_levels
from src.output import write_asset_outputs


def _already_ran_today(asset_key: str, today_central: str) -> bool:
    path = f"{config.DATA_DIR}/{asset_key}_levels.json"
    if not os.path.exists(path):
        return False
    with open(path) as f:
        data = json.load(f)
    return data.get("generated_at_central", "")[:10] == today_central


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--force",
        action="store_true",
        help="run even if today's data already exists (used for manual/workflow_dispatch runs)",
    )
    args = parser.parse_args()

    today_central = pd.Timestamp.now(tz=config.LOCAL_TIMEZONE).strftime("%Y-%m-%d")

    exit_code = 0
    for asset_key, pair in config.ASSETS.items():
        if not args.force and _already_ran_today(asset_key, today_central):
            print(f"{asset_key}: already ran today ({today_central}) — skipping.")
            continue

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
