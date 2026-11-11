"""Write monthly chart chunks and retain history older than a rolling refresh."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import config
from src.output import atomic_write_json


def write_monthly_archive(asset: str, timeframes: dict[str, list[dict]], source: str) -> None:
    manifest_path = Path(f"{config.DATA_DIR}/archive/{asset}/manifest.json")
    previous = json.loads(manifest_path.read_text()) if manifest_path.exists() else None
    if previous and previous["source"] != source:
        raise ValueError(f"{asset} archive source changed; refusing to combine different feeds")
    manifest = {"asset": asset.upper(), "source": source, "timeframes": {}}
    for timeframe, rows in timeframes.items():
        grouped: dict[str, list[dict]] = {}
        for row in rows:
            month = datetime.fromtimestamp(int(row["time"]), timezone.utc).strftime("%Y-%m")
            grouped.setdefault(month, []).append(row)
        prior_entries = {
            entry["month"]: entry
            for entry in (previous or {}).get("timeframes", {}).get(str(timeframe), [])
        }
        entries_by_month = dict(prior_entries)
        for month, month_rows in sorted(grouped.items()):
            relative_path = f"archive/{asset}/{timeframe}/{month}.json"
            path = Path(f"{config.DATA_DIR}/{relative_path}")
            if month in prior_entries:
                old_rows = json.loads(path.read_text())
                # The first month of a rolling window starts mid-month. Older
                # backfilled bars, including a full first session, win there.
                old_wins = old_rows[0]["time"] < month_rows[0]["time"]
                ordered = (month_rows, old_rows) if old_wins else (old_rows, month_rows)
                month_rows = list({row["time"]: row for part in ordered for row in part}.values())
                month_rows.sort(key=lambda row: row["time"])
            atomic_write_json(f"{config.DATA_DIR}/{relative_path}", month_rows, compact=True)
            entries_by_month[month] = (
                {
                    "month": month,
                    "path": relative_path,
                    "first": month_rows[0]["time"],
                    "last": month_rows[-1]["time"],
                    "count": len(month_rows),
                }
            )
        manifest["timeframes"][str(timeframe)] = [entries_by_month[month] for month in sorted(entries_by_month)]
    Path(f"{config.DATA_DIR}/archive/{asset}").mkdir(parents=True, exist_ok=True)
    atomic_write_json(f"{config.DATA_DIR}/archive/{asset}/manifest.json", manifest, compact=True)
