"""All tunable parameters for the level engine, in one place."""

# --- Exchange ---
KRAKEN_BASE_URL = "https://api.kraken.com/0/public/OHLC"
# Kraken's display pair names (assetVersion=1). Internal names (XXBTZUSD,
# XETHZUSD) also work but are less readable; confirmed live against the
# API on 2026-10-04.
ASSETS = {
    "btc": "BTC/USD",
    "eth": "ETH/USD",
}
INTERVAL_4H = 240   # minutes
INTERVAL_1D = 1440  # minutes
# Kraken returns at most this many of the most recent candles per call,
# regardless of `since`. Confirmed live: 721 rows including the forming one.
MAX_CANDLES_PER_CALL = 720
FETCH_RETRIES = 3
FETCH_BACKOFF_SECONDS = 2  # doubles each retry: 2s, 4s, 8s

# --- Schedule ---
LOCAL_TIMEZONE = "America/Chicago"
RUN_HOUR_LOCAL = 5  # 5 AM local triggers the real run; other cron firings exit early
STALE_AFTER_HOURS = 26  # site shows a warning if data is older than this

# --- Volume profile ---
RANGE_DAYS = 60          # lookback window of 4h candles for the volume profile
VOLUME_BIN_PCT = 0.0025  # bin width as a fraction of current price (0.25%)
VALUE_AREA_PCT = 0.70    # expand from POC until this fraction of volume is covered

# --- Swing pivots / golden pocket ---
PIVOT_N = 5           # candles on each side that must be lower/higher for a pivot
MIN_SWING_PCT = 8.0    # minimum % move for a leg to count as a swing
GOLDEN_POCKET_LOW = 0.618   # retracement zone lower bound
GOLDEN_POCKET_HIGH = 0.65   # retracement zone upper bound
PIVOT_LOOKBACK_DAYS = 365   # how far back into daily candles to search for pivots/legs

# --- Confluence ---
CONFLUENCE_MERGE_PCT = 0.005  # merge levels within 0.5% of each other into one zone

# --- Output ---
DATA_DIR = "site/data"
HISTORY_DIR = "site/data/history"
