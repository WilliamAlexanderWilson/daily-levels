"""Run the frozen spy-or-reclaim-v1 historical research once.

Prints and writes no site-facing signal. Use the result only as described in
docs/SPY-RANGE-RECLAIM-PREREGISTRATION.md.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from src.spy.fetch import fetch_alpaca_5m
from src.spy.range_reclaim import (
    CANDIDATES,
    generate_trades,
    historical_holdout_passes,
    partition,
    summarize,
    validation_passes,
)

RESEARCH_OUTPUT = Path("research/spy_or_reclaim_v1.json")
SITE_OUTPUT = Path("site/data/spy_range_reclaim.json")


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


def main() -> int:
    bars = fetch_alpaca_5m("SPY")
    candidates = []
    for candidate in CANDIDATES:
        trades = generate_trades(bars, candidate)
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
        selected_trades = partition(generate_trades(bars, candidate))["holdout"]
        selected["holdout"] = summarize(selected_trades)
        historical_gate_passed = historical_holdout_passes(selected_trades)

    payload = {
        "method_version": "spy-or-reclaim-v1",
        "source": "Alpaca IEX 5-minute raw bars",
        "bars": len(bars),
        "coverage_start_utc": bars.index.min().isoformat(),
        "coverage_end_utc": bars.index.max().isoformat(),
        "selected_key": selected_key,
        "historical_gate_passed": historical_gate_passed,
        "candidates": candidates,
    }
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
