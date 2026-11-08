"""Run the frozen spy-or-reclaim-v1 historical research once.

Prints and writes no site-facing signal. Use the result only as described in
docs/SPY-RANGE-RECLAIM-PREREGISTRATION.md.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path

import pandas as pd

from src.spy.fetch import fetch_alpaca_5m
from src.spy.range_reclaim import (
    CANDIDATES,
    ET,
    VALIDATION_END,
    _regular_session,
    generate_trades,
    historical_holdout_passes,
    partition,
    summarize,
    validation_passes,
)

RESEARCH_OUTPUT = Path("research/spy_or_reclaim_v1.json")
SITE_OUTPUT = Path("site/data/spy_range_reclaim.json")
SOURCE_SNAPSHOT = Path("research/spy_or_reclaim_v1_source.csv.gz")


def write_source_snapshot(bars: pd.DataFrame) -> None:
    """Freeze source rows with deterministic gzip metadata for reproducibility."""
    buffer = io.StringIO()
    bars.to_csv(buffer, index_label="timestamp", float_format="%.17g")
    SOURCE_SNAPSHOT.parent.mkdir(parents=True, exist_ok=True)
    with SOURCE_SNAPSHOT.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed:
            compressed.write(buffer.getvalue().encode("utf-8"))


def read_source_snapshot() -> pd.DataFrame:
    return pd.read_csv(
        SOURCE_SNAPSHOT,
        parse_dates=["timestamp"],
        index_col="timestamp",
    )


def source_sha256() -> str:
    return hashlib.sha256(SOURCE_SNAPSHOT.read_bytes()).hexdigest()


def write_outputs(payload: dict) -> None:
    """Persist the frozen audit result and the identical public evidence file."""
    serialized = json.dumps(payload, indent=2, allow_nan=False) + "\n"
    for output in (RESEARCH_OUTPUT, SITE_OUTPUT):
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(serialized)


def publish_existing() -> int:
    """Publish an already-computed result without fetching or reopening data."""
    payload = json.loads(RESEARCH_OUTPUT.read_text())
    write_outputs(payload)
    print(f"published frozen result to {SITE_OUTPUT}")
    return 0


def build_payload(bars: pd.DataFrame, trade_generator=generate_trades) -> dict:
    local_index = bars.index.tz_convert(ET)
    pre_holdout = bars.loc[local_index < VALIDATION_END]
    candidates = []
    for candidate in CANDIDATES:
        # Candidate discovery is physically capped before the locked holdout.
        # A non-selected candidate never receives a holdout timestamp.
        trades = trade_generator(pre_holdout, candidate)
        parts = partition(trades)
        candidates.append({
            "spec": {
                "key": candidate.key,
                "opening_minutes": candidate.opening_minutes,
                "target": candidate.target,
                "relative_volume": candidate.relative_volume,
            },
            "train": summarize(parts["train"]),
            "validation": summarize(parts["validation"]),
            "validation_4bps": summarize(parts["validation"], "net_return_4bps"),
            "validation_passed": validation_passes(parts["validation"]),
            "holdout": None,
        })

    passing = [item for item in candidates if item["validation_passed"]]
    selected = max(
        passing,
        key=lambda item: item["validation"]["expectancy_pct"],
        default=None,
    )
    selected_key = selected["spec"]["key"] if selected else None
    historical_gate_passed = False
    # The holdout is calculated only for a rule selected without looking at
    # holdout results. Non-selected candidates remain deliberately blank.
    if selected_key:
        candidate = next(spec for spec in CANDIDATES if spec.key == selected_key)
        # Only the validation-selected rule is allowed to process the full
        # snapshot and expose its locked holdout partition.
        selected_trades = partition(trade_generator(bars, candidate))["holdout"]
        selected["holdout"] = summarize(selected_trades)
        historical_gate_passed = historical_holdout_passes(selected_trades)

    return {
        "method_version": "spy-or-reclaim-v1",
        "source": "Alpaca IEX 5-minute raw bars",
        "source_snapshot": str(SOURCE_SNAPSHOT),
        "source_snapshot_sha256": source_sha256(),
        "raw_bars": len(bars),
        "regular_session_bars": len(_regular_session(bars)),
        "coverage_start_utc": bars.index.min().isoformat(),
        "coverage_end_utc": bars.index.max().isoformat(),
        "selected_key": selected_key,
        "historical_gate_passed": historical_gate_passed,
        "candidates": candidates,
    }


def main() -> int:
    if SOURCE_SNAPSHOT.exists():
        bars = read_source_snapshot()
    else:
        bars = fetch_alpaca_5m("SPY")
        write_source_snapshot(bars)
        bars = read_source_snapshot()
    payload = build_payload(bars)
    write_outputs(payload)
    print(json.dumps(payload, indent=2, allow_nan=False))
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--publish-existing",
        action="store_true",
        help="copy the frozen research result to the site without refetching data",
    )
    args = parser.parse_args()
    raise SystemExit(publish_existing() if args.publish_existing else main())
