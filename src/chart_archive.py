"""Write immutable monthly chart chunks plus a small lookup manifest."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import config
from src.output import atomic_write_json


def write_monthly_archive(asset: str, timeframes: dict[str, list[dict]], source: str) -> None:
    manifest = {"asset": asset.upper(), "source": source, "timeframes": {}}
    for timeframe, rows in timeframes.items():
        grouped: dict[str, list[dict]] = {}
        for row in rows:
            month = datetime.fromtimestamp(int(row["time"]), timezone.utc).strftime("%Y-%m")
            grouped.setdefault(month, []).append(row)
        entries = []
        for month, month_rows in sorted(grouped.items()):
            relative_path = f"archive/{asset}/{timeframe}/{month}.json"
            atomic_write_json(f"{config.DATA_DIR}/{relative_path}", month_rows, compact=True)
            entries.append(
                {
                    "month": month,
                    "path": relative_path,
                    "first": month_rows[0]["time"],
                    "last": month_rows[-1]["time"],
                    "count": len(month_rows),
                }
            )
        manifest["timeframes"][str(timeframe)] = entries
    Path(f"{config.DATA_DIR}/archive/{asset}").mkdir(parents=True, exist_ok=True)
    atomic_write_json(f"{config.DATA_DIR}/archive/{asset}/manifest.json", manifest, compact=True)
