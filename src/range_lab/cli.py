"""Generate the static Range Lab research artifact for the website."""

from src.output import atomic_write_json
from src.range_lab.engine import build_range_lab
from src.range_lab.fetch import fetch_btc_4h


def main() -> int:
    print("Fetching deep Kraken BTC 4-hour history...")
    candles = fetch_btc_4h()
    print(f"  {len(candles)} completed candles")
    result = build_range_lab(candles)
    atomic_write_json("site/data/btc_range_lab.json", result)
    selected = next(
        (item for item in result["candidates"] if item["spec"]["key"] == result["selected_key"]),
        None,
    )
    print(f"  selected by validation: {selected['spec']['label'] if selected else 'none'}")
    print(f"  holdout passed: {result['holdout_passed']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
