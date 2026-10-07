# Daily Levels — BTC & ETH key-level dashboard

A small site that shows a live candlestick chart for BTC and ETH with
automatically calculated key price levels drawn and labeled on it. Levels
are recalculated once a day at 5:00 AM US Central and held fixed until the
next run; the chart itself ticks live, independent of that daily
calculation. **This is a map of levels, not a signal service — no
buy/sell calls.**

Live: https://williamalexanderwilson.github.io/daily-levels/

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
3. The same Action run also replays history day by day (`src/backtest/`)
   to build a hold-rate scorecard — how often each level type has
   historically held vs. broken when touched — and writes that alongside.
4. The Action commits those JSON files to the repo, then deploys the site
   to GitHub Pages itself (see "Why Pages deploys from the workflow"
   below).
5. The static site in `site/` reads the levels/scorecard JSON for its
   lines, labels, and table — that part only updates once a day. The
   **chart's candles are fetched live, directly from Kraken, from the
   browser** (polled every 15s) — there is no server and no database
   anywhere in this.

## Local setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# run the level engine for real (writes into site/data/)
python -m src.run --force

# run the backtest scorecard for real (writes into site/data/)
python -m src.backtest.cli

# run the tests
python -m pytest

# view the site locally
cd site && python3 -m http.server 8000
# open http://localhost:8000
```

`--force` skips the 5 AM Central gate, which is what you want for a manual
local run — without it, `src/run.py` only runs during that hour and exits
immediately otherwise. `src.backtest.cli` isn't time-gated at all; it
replays history, not "now," so it's safe to run anytime.

## Why Pages deploys from the workflow, not "deploy from a branch"

GitHub Pages' classic "deploy from a branch" source only serves `/` or
`/docs`, not `/site`. Pages is instead configured with `build_type:
workflow`, and `update-levels.yml` deploys it directly after committing
new data (`actions/upload-pages-artifact` + `actions/deploy-pages`). That
also sidesteps a real gotcha: a push made with the default `GITHUB_TOKEN`
(the Action's own commit) does **not** trigger another workflow's `on:
push` — GitHub suppresses that to prevent recursive runs — so a separate
"deploy on push" workflow would never actually fire after the daily data
update. `deploy-pages.yml` still exists for the case of editing `site/`
directly and pushing it yourself with your own credentials, which does
trigger normally.

To (re)enable Pages on a fork or a new repo:

```bash
gh api -X POST repos/<owner>/<repo>/pages -f "build_type=workflow"
```

## Triggering a manual run

GitHub → Actions → "Update levels" → **Run workflow**. This calls
`python -m src.run --force`, bypassing the 5 AM Central gate, so it always
does a real fetch-and-recalculate regardless of when you click it, then
runs the backtest and deploys.

You can also trigger it from the CLI:

```bash
gh workflow run update-levels.yml
```

## The live chart vs. the daily levels

These are two independent systems that happen to share one page:

- **Levels** (the lines, zones, and tables) come from the once-a-day
  snapshot in `site/data/{asset}_levels.json` and `_scorecard.json`. Fixed
  until the next 5 AM run — that's deliberate, it's what makes them a
  stable reference instead of a moving target.
- **The chart** (candles, current price) is fetched directly from Kraken
  by the browser (`fetchKrakenCandles` in `site/app.js`), for whichever of
  the seven timeframes (1m/5m/15m/30m/1h/4h/Daily) is selected, polled
  every 15s. Kraken's public OHLC endpoint sends CORS headers that allow
  this with no server and no API key — confirmed directly against
  `api.kraken.com`. It occasionally fails a request with no CORS header at
  all after a burst of requests in a short window (observed in practice,
  Cloudflare-fronted); `fetchKrakenCandles` retries 3x with backoff to
  absorb that.
- The 4H view's default zoom frames exactly the `RANGE_DAYS`-day window
  the volume-profile levels are computed from (read from the levels JSON's
  own `config` block, not duplicated as a constant), so those lines land
  on the actual high/low on screen. The other timeframes use `fitContent()`.
- **Order book liquidity walls** are also live-only: `fetchOrderBookWalls`
  polls Kraken's public spot order book (`/0/public/Depth`) on the same
  15s cadence, and shows the top 3 bid/ask price levels per side that are
  at least 2x the book's median resting size — real orders sitting on the
  book right now, not a modeled estimate. (A true liquidation heatmap
  would need every trader's entry price and leverage across every
  exchange, which no exchange publishes — that's what tools like
  Coinglass are actually estimating, not displaying as fact. Kraken
  Futures' open-interest/funding endpoint has no CORS header at all, so
  it isn't fetchable from the browser at all; it would need to go through
  the daily Python engine instead, same as everything else that isn't
  live.)
- **Click any row in the Level table to snap the chart to it** — zooms the
  price axis to frame that level tightly. Click the same row again (or
  select a different one) to go back to the default view.

## The hold-rate scorecard

`src/backtest/` replays the level engine day by day over the full ~2 years
of daily history Kraken's API allows, using **only** data that would have
existed as of each replayed day (`src/backtest/replay.py` — no lookahead,
proven by `tests/test_backtest_replay.py`). For every level touched, it
classifies the outcome over the following 10 days as a **hold** (price
moved `BACKTEST_HOLD_MOVE_PCT` away from the level before any close landed
`BACKTEST_BREAK_CLOSE_PCT` beyond it) or a **break** (the reverse
happened first); if neither resolves within the window, it's
"inconclusive" and excluded from the hold rate rather than forced into
either bucket.

One real constraint: Kraken caps history at 720 candles regardless of
interval, so 4h candles only reach back ~120 days — too thin to backtest
the volume-profile levels (POC/VAH/VAL/Range) on their native timeframe
with a usable sample size. `src/backtest/engine.py` computes those specific
levels from **daily** candles instead, same methodology, coarser bins, far
deeper replay history (~720 days vs. ~60). The live engine is untouched —
this is a backtest-only approximation, and the scorecard flags anything
under `BACKTEST_MIN_TOUCHES_CONFIDENT` (30) resolved touches as
low-confidence.

This is historical frequency, not a prediction — the site says so right
next to the table.

**Round numbers** ("Round number" in the scorecard) are included as a
level type too — psychological whole-number levels ($85,000 for BTC,
$2,700 for ETH), scaled to price magnitude (`src/levels/round_numbers.py`:
step = `10**(digits-2)`, so $1,000 steps for a five-figure BTC price,
$100 for four-figure ETH). Unlike every other level, these are purely
arithmetic, not derived from trade data, so they're **not** part of the
once-a-day snapshot — the live site recomputes the nearest one
continuously from the live price (reimplemented in `site/app.js`; keep
both in sync if the formula changes), while the backtest tests them the
same way as everything else: not "did price print the exact dollar
amount," but "did it come within `ROUND_NUMBER_TOLERANCE_FRACTION` of a
step (a quarter-step — $250 for BTC) and then hold or break." Tested
across every round number the price actually traded near over the full
replay — dozens of distinct values per asset, not just whatever's current
today.

## Futures context (funding rate, open interest)

`src/context/futures.py` fetches Kraken Futures' aggregate perpetual data
server-side, once a day, and bakes it into `{asset}_levels.json` as
`futures_context` — read directly off the already-loaded levels JSON on
the site, no extra client-side fetch. It's server-side because the
endpoint (`futures.kraken.com/derivatives/api/v3/tickers`) sends **no
CORS header at all** (checked directly), unlike every other Kraken
endpoint this project uses.

Two things worth knowing if you touch this: the ticker's `fundingRate`
field is **not a percentage** — it's an absolute rate (BTC per $1 contract
per hour); `relativeFundingRate` is the field exchanges actually display
as "the funding rate" (confirmed against Kraken's docs and a live
response — using the wrong field would show a nonsensical ~60% instead of
the real ~0.0008%). And Kraken Futures pays funding **hourly**, not every
8 hours like most exchanges — the site labels it "/hr" explicitly so it
isn't misread against an 8h mental model.

## Trade journal

Mark a trade by clicking "+ Mark trade" above the chart, then clicking
where you got in — a small form asks for long/short and an optional note,
and `site/app.js` saves it to **this browser's localStorage**, keyed per
asset. There's no server or account involved, so it won't follow you to a
different browser or device, and clearing site data wipes it (a
deliberate tradeoff — the alternative was a real backend). Markers render
on the chart via lightweight-charts' `createSeriesMarkers` plugin API
(v5's replacement for v4's `series.setMarkers`), and a trade is stored by
a canonical unix timestamp rather than whatever display format the active
timeframe happened to use at click time, so it renders correctly on any
timeframe later, as long as that timeframe's currently-loaded candles
actually cover it.

You can also just **type the price** instead of clicking the chart — a
number field sits right next to "+ Mark trade" for exact fills.

## Jump to a level

The "Jump to level" dropdown above the chart lists every level from the
Level table, closest to the live price first, and snaps the chart to
whichever one you pick — same as clicking its row in the table below
(they stay in sync with each other either way). Each entry also shows a
live percentage: 0% means price is sitting at the nearest level on the
*other* side, 100% means price has arrived at this one — so as price
moves toward a level, its number climbs. It's anchored on the two real
levels price is actually between, not an arbitrary cutoff, so a level
further away naturally shows a lower percentage than one price is about
to touch.

**Proximity curve** (`src/backtest/round_proximity.py`,
`{asset}_round_proximity.json`): re-runs the round-number touch/hold/break
classification at 6 tolerance widths instead of 1 (100%/50%/25%/10%/5%/2%
of a step), to test whether the odds actually change depending on how
close price gets before reacting, rather than assuming one number covers
it. They do, substantially — hold rate drops the closer price gets to the
exact number (BTC: 55%→42% from a full step away down to 2%; ETH:
69%→40%), for both assets, with 600+ resolved touches even at the
tightest tier. The site shows this as 3 of the 6 tiers rendered as nested
bands around the live nearest round number, each labeled with its own
hold rate.

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
| `BACKTEST_FORWARD_DAYS` | How many days forward the scorecard watches for a touch to resolve as hold/break. |
| `BACKTEST_HOLD_MOVE_PCT` / `BACKTEST_BREAK_CLOSE_PCT` | The hold vs. break thresholds, as % away from / beyond the level. |
| `BACKTEST_MIN_TOUCHES_CONFIDENT` | Resolved touches below this get flagged low-confidence. |
| `ROUND_NUMBER_TOLERANCE_FRACTION` | How close (as a fraction of the round-number step) counts as "touched" for backtest purposes. |

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
The browser-side `fetchKrakenCandles` in `site/app.js` has its own,
separate retry logic for the live chart — see "The live chart vs. the
daily levels" above.

## Repo layout

```
config.py                   # every tunable, one place
src/
  fetch.py                  # Kraken access — the only file that knows the source
  run.py                    # entry point: runs the level engine for every asset, writes output
  output.py                 # atomic JSON writes + history append
  levels/
    volume_profile.py       # POC / VAH / VAL
    pivots.py                # swing pivot detection
    golden_pocket.py         # 0.618-0.65 retracement of the most recent qualifying leg
    reference_levels.py      # prior week/month high-low, current week/month open
    flip_level.py             # old resistance/support flipped the other way
    round_numbers.py           # psychological whole-number levels, scaled to price magnitude
    confluence.py             # merges nearby levels, tags type/distance/strength
    daily_diff.py               # new/moved/unchanged/removed vs. the prior snapshot
    engine.py                  # orchestrates all of the above per asset (live, 4h+daily)
  backtest/
    engine.py                 # daily-candle-only approximation of the level engine, for replay depth
    replay.py                  # day-by-day replay with the no-lookahead guarantee
    outcomes.py                 # touch/hold/break classification for one level
    scorecard.py                 # aggregates outcomes per level type per asset
    cli.py                        # entry point: python -m src.backtest.cli
tests/                        # unit tests with hand-built fixtures + one real-response fixture
site/                         # static HTML/CSS/JS, hosted on GitHub Pages
  app.js                     # live chart (direct Kraken polling) + renders the daily levels/scorecard
  data/                      # JSON written by the Action; the page reads levels/scorecard from here
.github/workflows/
  update-levels.yml          # the daily cron: level engine + backtest + commit + Pages deploy
  deploy-pages.yml           # redeploys Pages on a direct push to site/** (e.g. editing the site by hand)
```

## Disclaimer

Informational only. Not financial advice.
