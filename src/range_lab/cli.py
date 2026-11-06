"""Generate the static Range Lab research artifact for the website."""

from src.output import atomic_write_json
from src.fetch import fetch_candles
from src.range_lab.engine import build_range_lab
from src.range_lab.fetch import fetch_btc_4h
from src.range_lab.reconciliation import reconcile_spot_futures


def main() -> int:
    print("Fetching deep Kraken BTC 4-hour history...")
    candles = fetch_btc_4h()
    print(f"  {len(candles)} completed candles")
    print("Fetching Kraken BTC/USD spot overlap...")
    spot_candles = fetch_candles("BTC/USD", 240)
    reconciliation = reconcile_spot_futures(candles, spot_candles)
    print(
        "  "
        f"{reconciliation['overlap_candles']} aligned candles; "
        f"{reconciliation['missing_in_spot']} missing in spot; "
        f"{reconciliation['missing_in_futures']} missing in futures"
    )
    result = build_range_lab(candles)
    result["spot_futures_reconciliation"] = reconciliation
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
