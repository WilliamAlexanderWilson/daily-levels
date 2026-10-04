# Daily Levels — BTC & ETH key-level dashboard

A small site that shows a candlestick chart for BTC and ETH with
automatically calculated key price levels drawn and labeled on it. Levels
are recalculated once a day at 5:00 AM US Central and held fixed until the
next run. **This is a map of levels, not a signal service — no buy/sell
calls.**

Phase 1 (this repo, right now): the level engine, the static site, and the
GitHub Action that runs it daily. Phase 2 (not built yet): a historical
level scorecard, multi-range confluence, a daily diff, and Telegram alerts.

## How it works

1. A GitHub Action runs `src/run.py` twice a day (10:00 and 11:00 UTC); the
   script itself checks the time in `America/Chicago` and only does
   anything during the 5 AM hour, so exactly one of those two firings is a
   real run regardless of daylight saving.
2. The engine (`src/levels/engine.py`) fetches 4h and daily OHLC candles
   from Kraken's public API for `BTC/USD` and `ETH/USD`, runs the volume
   profile / pivot / golden pocket / reference-level / flip-level
   calculations, merges nearby levels into confluence zones, and writes the
   result as JSON into `site/data/`.
3. The Action commits those JSON files straight to the repo.
4. The static site in `site/` (hosted on GitHub Pages) reads that JSON and
   renders the chart, levels, and table. There is no server and no
   database — the page only ever reads files that are already in the repo.

## Local setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# run the engine for real (writes into site/data/)
python -m src.run --force

# run the tests
python -m pytest

# view the site locally
cd site && python3 -m http.server 8000
# open http://localhost:8000
```

`--force` skips the 5 AM Central gate, which is what you want for a manual
local run — without it, `src/run.py` only runs during that hour and exits
immediately otherwise.

## Enabling GitHub Pages

1. Push this repo to GitHub.
2. In the repo's Settings → Pages, set **Source** to "Deploy from a
   branch", branch `main`, folder `/site`.
3. The site will be live at `https://<your-username>.github.io/<repo>/`
   within a minute or two of the first push.

Because the Action commits new JSON to `main`, every daily run also
triggers a new Pages deployment automatically — no separate deploy step.

## Triggering a manual run

GitHub → Actions → "Update levels" → **Run workflow**. This calls
`python -m src.run --force`, bypassing the 5 AM Central gate, so it always
does a real fetch-and-recalculate regardless of when you click it.

You can also trigger it from the CLI:

```bash
gh workflow run update-levels.yml
```

## Config (`config.py`)

Every tunable number lives in `config.py`, each with a comment explaining
it. The ones worth knowing about up front:

| Setting | What it controls |
|---|---|
| `RANGE_DAYS` | Lookback window (in days of 4h candles) for the volume profile and range high/low. |
| `VOLUME_BIN_PCT` | Width of each volume-profile bin, as a fraction of current price. |
| `VALUE_AREA_PCT` | Fraction of volume the value area (VAH/VAL) must cover, expanding out from the POC. |
| `PIVOT_N` | How many candles on each side must be lower/higher for a candle to count as a swing pivot. |
| `MIN_SWING_PCT` | Minimum % move for a leg between two pivots to qualify for the golden pocket calculation. |
| `GOLDEN_POCKET_LOW` / `GOLDEN_POCKET_HIGH` | The Fibonacci retracement band (0.618–0.65) applied to the most recent qualifying swing leg. |
| `PIVOT_LOOKBACK_DAYS` | How far back into daily candles to search for pivots and swing legs. |
| `CONFLUENCE_MERGE_PCT` | Levels within this % of each other are merged into one zone. |
| `STALE_AFTER_HOURS` | How old `generated_at` can get before the site shows a stale-data warning. |
| `RUN_HOUR_LOCAL` | The Central-time hour `src/run.py` treats as "the daily run" (5 AM). |

## Data source: Kraken

`src/fetch.py` is the only file that knows the data source is Kraken —
everything else calls `fetch_candles(symbol, interval)`. It hits
`GET https://api.kraken.com/0/public/OHLC` with `assetVersion=1` so pairs
can be addressed by their display names (`BTC/USD`, `ETH/USD`) rather than
Kraken's internal asset codes. Kraken returns at most 720 of the most
recent candles per call regardless of the `since` parameter, and always
includes one still-forming candle at the end, which `fetch_candles` drops.

Retries: up to 3 attempts per call with exponential backoff (2s, 4s, 8s).
If a run fails partway through, nothing in `site/data/` is touched —
writes in `src/output.py` are atomic (write-to-temp, then rename), and a
failed asset simply isn't written, so the site keeps showing yesterday's
data (with the stale-data banner kicking in after `STALE_AFTER_HOURS`).

## Repo layout

```
config.py                   # every tunable, one place
src/
  fetch.py                  # Kraken access — the only file that knows the source
  run.py                    # entry point: runs the engine for every asset, writes output
  output.py                 # atomic JSON writes + history append
  levels/
    volume_profile.py       # POC / VAH / VAL
    pivots.py                # swing pivot detection
    golden_pocket.py         # 0.618-0.65 retracement of the most recent qualifying leg
    reference_levels.py      # prior week/month high-low, current week/month open
    flip_level.py             # old resistance/support flipped the other way
    confluence.py             # merges nearby levels, tags type/distance/strength
    engine.py                  # orchestrates all of the above per asset
tests/                        # unit tests with hand-built fixtures + one real-response fixture
site/                         # static HTML/CSS/JS, hosted on GitHub Pages
  data/                      # JSON written by the Action; the page only reads this
.github/workflows/
  update-levels.yml          # the daily cron (+ manual trigger)
```

## Disclaimer

Informational only. Not financial advice.
