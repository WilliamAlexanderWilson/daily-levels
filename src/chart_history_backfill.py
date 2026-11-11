"""One-time backfill of chart-only equity archives from available Alpaca IEX bars.

Run from the repository root with existing Alpaca data credentials:
    python -m src.chart_history_backfill spy qqq nvda

The scheduled exporters still use their bounded research windows. The monthly
archive writer retains these older chart chunks on subsequent refreshes.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

import config
from src.chart_archive import write_monthly_archive
from src.spy.chart_timeframes import CHART_TIMEFRAMES_MINUTES, build_chart_timeframes
from src.spy.export import _frame_to_json
from src.spy.fetch import fetch_alpaca_window
from src.spy.heikin_ashi import TIMEFRAMES_MINUTES, resample_session


def backfill(asset: str) -> None:
    manifest_path = Path(config.DATA_DIR) / "archive" / asset / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    earliest = min(entries[0]["first"] for entries in manifest["timeframes"].values())
    first_month = pd.Timestamp(earliest, unit="s", tz="UTC").replace(day=1).normalize()
    # Rebuild the entire boundary month so its first session's larger bars
    # are complete, even if the rolling export began partway through it.
    end = first_month + pd.DateOffset(months=1)
    source_minutes = 1 if asset == "spy" else 5
    print(f"{asset.upper()}: fetching {source_minutes}m IEX bars before {end.date()}", flush=True)
    frame = fetch_alpaca_window(asset.upper(), source_minutes, pd.Timestamp("1990-01-01", tz="UTC"), end)
    if frame.index.min().timestamp() >= earliest:
        raise ValueError(f"{asset} source returned no bars before the published archive")

    if asset == "spy":
        timeframes = build_chart_timeframes(frame, end)
        minutes_list = CHART_TIMEFRAMES_MINUTES
    else:
        timeframes = {minutes: resample_session(frame, minutes) for minutes in TIMEFRAMES_MINUTES}
        minutes_list = TIMEFRAMES_MINUTES
    rows = {str(minutes): _frame_to_json(timeframes[minutes], None) for minutes in minutes_list}
    write_monthly_archive(asset, rows, manifest["source"])
    print(f"{asset.upper()}: added chart history from {frame.index.min().date()} through {end.date()}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("assets", nargs="+", choices=("spy", "qqq", "nvda"))
    args = parser.parse_args()
    for asset in args.assets:
        backfill(asset)


if __name__ == "__main__":
    main()
