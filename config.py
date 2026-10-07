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
RUN_HOUR_LOCAL = 5  # target hour for the daily run - informational only, src/run.py
                    # gates on "already ran today," not this hour (GitHub's cron can
                    # fire hours late; see the docstring in src/run.py)
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

# --- Liquidation estimate ---
# This is a MODEL, not verified position data - no exchange publishes real
# entry prices or leverage, on Kraken or anywhere else (see
# src/levels/liquidation_estimate.py for the full assumptions). Built from
# the real volume profile (actual traded volume at each price, same data
# POC/VAH/VAL already use) projected forward through a few standard perp
# leverage tiers. Every bin's volume is split evenly across these tiers AND
# evenly between long/short, because there is no real signal to weight
# either assumption differently - splitting evenly is the most honest
# default, not a claim that it's accurate.
LIQUIDATION_LEVERAGE_TIERS = [10, 25, 50, 100]
LIQUIDATION_MAX_DISTANCE_PCT = 0.25  # don't project further than this from current price

# --- Output ---
DATA_DIR = "site/data"
HISTORY_DIR = "site/data/history"

# --- Backtest / scorecard ---
# Kraken caps history at 720 candles regardless of date range, same limit
# that applies live (confirmed against the API). That's ~2 years of daily
# candles but only ~120 days of 4h candles - too thin to replay the
# volume-profile levels (POC/VAH/VAL/Range) on their native 4h timeframe
# with any real sample size. The backtest computes those specific levels
# from daily candles instead, same methodology, coarser bins, far deeper
# replay history. The live engine (src/levels/engine.py) is untouched -
# this only affects the backtest's own approximation.
BACKTEST_FORWARD_DAYS = 10      # how many days forward to watch for touch/hold/break
BACKTEST_HOLD_MOVE_PCT = 2.0    # price must move this far from the level to count as "held"
BACKTEST_BREAK_CLOSE_PCT = 1.0  # a daily close this far beyond the level counts as "broken"
BACKTEST_MIN_TOUCHES_CONFIDENT = 30  # fewer resolved touches than this is flagged low-confidence

# Round numbers are tested as a zone, not an exact point: "did price come
# within a quarter-step of the round number" (e.g. for BTC's $1,000 step,
# within $250), not "did it trade at the exact dollar." A trader watching
# $85,000 cares whether price got close and reacted, not whether it
# printed 85000.00 to the penny.
ROUND_NUMBER_TOLERANCE_FRACTION = 0.25

# --- Daily diff ---
# A level's price is reconstructed as its merged zone's midpoint for
# diffing purposes (the pre-merge per-kind price isn't retained in
# output). Changes smaller than this are noise, not a real move.
DAILY_DIFF_MOVE_THRESHOLD_PCT = 0.1
