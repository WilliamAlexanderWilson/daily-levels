# Daily Levels

BTC & ETH key-level dashboard. Input: Kraken public market data. Output: a
static site with a live candlestick chart, a daily-computed set of key
price levels, a historical hold-rate scorecard, and a day-over-day diff —
all informational, no trade signals.

Live: https://williamalexanderwilson.github.io/daily-levels/
Repo: https://github.com/WilliamAlexanderWilson/daily-levels (public)

---

## Product philosophy — read this before adding anything

**"A map of levels, not a signal service: no buy/sell calls."** That line
opened the original spec and has held through every feature added since.

The user has asked multiple times, in different phrasing, for an
indicator or strategy that tells them exactly where to enter a long or
short. Each time, the answer has been the same and should stay the same:
**no indicator or strategy reliably tells you where to enter — and
building one that looks confident while not actually having an edge would
be actively harmful, not a neutral feature add.** This isn't a legal
hedge, it's a factual claim: if a mechanical edge like that existed and
worked, it would be arbitraged away by the act of enough people using it.

What's actually been built in response to that ask, and is the right kind
of thing to keep building: tools that surface real historical frequency
so the user can decide for themselves, clearly labeled as odds, never as
calls.

- The hold-rate scorecard (`src/backtest/`) — how often each level type
  has actually held vs. broken, historically, with sample size and a
  low-confidence flag.
- The nearest-level cards on the site — the odds for the specific zone
  closest to the live price, sitting right next to that price instead of
  buried in a table.
- Descriptive indicators (moving averages, VWAP, Bollinger Bands) would
  also fit this philosophy if asked for. Momentum oscillators (RSI/MACD)
  are a greyer area — still fine as raw descriptive values the user reads
  themselves, not as anything that outputs a recommendation.

If asked to build any of the following, push back rather than comply:
- An indicator or feature that tells the user when to enter/exit a trade
- Auto-posting or auto-trading of any kind
- Anything that presents historical frequency as a prediction rather than
  a frequency

A YouTube trading strategy transcript was reviewed once (see git log
around the hold-rate scorecard / nearest-level cards commits for
context). It turned out to be discretionary range-trading using the same
levels already on this dashboard (VAH/VAL, golden pocket, a flip/must-
hold level) plus macro commentary and a paid-community pitch — not a
hidden mechanical signal. If another strategy video/transcript comes up,
expect the same pattern: look for which of our existing levels it's
actually describing, rather than assuming there's a new indicator to
build.

---

## Stack

| Layer | Choice |
|---|---|
| Level engine, backtest | Python 3.13 (3.11 targeted, see note below), stdlib + requests + pandas + pytest |
| Scheduler | GitHub Actions cron (`update-levels.yml`), gated to the 5 AM America/Chicago hour |
| Data source | Kraken public REST OHLC API — no key, no auth, confirmed CORS-friendly for direct browser use |
| Chart | TradingView lightweight-charts v5 (`addSeries(CandlestickSeries, ...)` API, not v4's `addCandlestickSeries`) |
| Site | Static HTML/CSS/JS, no framework, no build step, hosted on GitHub Pages |
| Hosting | GitHub Pages, **deployed via the Actions workflow**, not classic branch-deploy (see gotcha below) |

No server, no database, anywhere in this project. Both the daily batch
job and the live chart talk to Kraken directly.

Python 3.11 was the original target; this machine only has 3.13 available
and nothing in the codebase depends on 3.11-specific behavior. CI
(`update-levels.yml`) pins `python-version: "3.11"` via
`actions/setup-python` and that's what actually matters for reproducibility.

---

## Repo layout

```
config.py                   # every tunable, one place, each with a comment
src/
  fetch.py                  # Kraken access — the only file that knows the source
  run.py                    # entry point: level engine for every asset, writes output
  output.py                 # atomic JSON writes, history append, load_previous_snapshot()
  levels/
    volume_profile.py       # POC / VAH / VAL
    pivots.py                # swing pivot detection
    golden_pocket.py         # 0.618-0.65 retracement of the most recent qualifying leg
    reference_levels.py      # prior week/month high-low, current week/month open
    flip_level.py             # old resistance/support flipped the other way
    confluence.py             # merges nearby levels, tags type/distance/strength
    daily_diff.py              # new/moved/unchanged/removed vs. the prior snapshot
    engine.py                  # orchestrates all of the above per asset (live, 4h+daily)
  backtest/
    engine.py                 # daily-candle-only approximation of the level engine, for replay depth
    replay.py                  # day-by-day replay with the no-lookahead guarantee
    outcomes.py                 # touch/hold/break classification for one level
    scorecard.py                 # aggregates outcomes per level type per asset
    cli.py                        # entry point: python -m src.backtest.cli
tests/                        # hand-built fixtures + one real-Kraken-response fixture
site/
  index.html / styles.css / app.js   # live chart (polls Kraken directly) + renders levels/scorecard/diff
  data/                       # JSON the Action writes; the page reads levels/scorecard from here
    history/{btc,eth}/YYYY-MM-DD.json   # one snapshot per day, feeds daily_diff
.github/workflows/
  update-levels.yml          # daily cron: level engine + backtest + commit + Pages deploy, all one job
  deploy-pages.yml           # redeploys Pages on a direct push to site/** (editing the site by hand)
```

---

## Where we are

**Phase 1 (core engine + site): fully built and live.**
Volume profile, range high/low, golden pocket, reference levels, flip
levels, confluence merging, the static site, the live chart, the daily
GitHub Action, Pages deployment.

**Phase 2: two of four pieces built.**

| Piece | Status |
|---|---|
| Hold-rate scorecard | ✅ Built. `src/backtest/`, day-by-day replay over ~2 years, no-lookahead proven by test. |
| Daily diff | ✅ Built. `src/levels/daily_diff.py`, new/moved/unchanged/removed badges on the site. |
| Multi-range volume profile agreement (30/60/120d) | ❌ Not built. |
| Telegram morning brief + proximity alerts | ❌ Not built — needs the user to create a Telegram bot and provide a token via GitHub Secrets before this can start. |
| Context strip (funding rate, 10Y yield, BTC dominance) | ❌ Not built — needs new free data sources, not yet researched. |

Also built, beyond the original Phase 1/2 spec, in response to live usage:
- **Live chart**, independent of the daily snapshot — 1m/5m/15m/30m/1h/4h/Daily
  timeframes, all polling Kraken directly every 15s, with retry+backoff.
- **Nearest-level cards** — nearest resistance/support to the live price,
  with their aggregated historical hold rate, right next to the price.
- Left-anchored level labels with a cluster-and-center decluttering
  algorithm (see gotchas below) instead of inline price-line titles.

---

## Gotchas worth knowing before touching this again

- **Kraken has no 10-minute interval.** Valid intervals: 1, 5, 15, 30, 60,
  240, 1440, 10080, 21600 minutes. Used 15m when the user asked for 10m.
- **Kraken caps history at 720 candles per call, regardless of `since`.**
  ~2 years of daily candles, but only ~120 days of 4h candles. This is why
  the backtest (`src/backtest/engine.py`) recomputes POC/VAH/VAL/Range
  from **daily** candles instead of 4h — not a bug, a deliberate tradeoff
  for replay depth. The live engine is untouched.
- **Kraken occasionally drops the CORS header entirely** after a burst of
  requests in a short window (observed on both localhost and the live
  site; Cloudflare-fronted, looked like bot-detection more than a simple
  rate limit). `fetchKrakenCandles` in `site/app.js` retries 3x with
  backoff for exactly this. Don't remove that retry thinking it's dead code.
- **GitHub Pages' classic "deploy from a branch" only serves `/` or
  `/docs`, not `/site`.** Pages is configured with `build_type: workflow`
  instead; `update-levels.yml` deploys it directly in the same job as the
  data commit.
- **A push made with the default `GITHUB_TOKEN` does not trigger another
  workflow's `on: push`** — GitHub suppresses that to prevent recursive
  runs. This is why Pages deploys from *inside* `update-levels.yml` rather
  than from `deploy-pages.yml`'s own push trigger reacting to that commit.
  `deploy-pages.yml` still exists for pushes made with a real user token
  (e.g. editing `site/` by hand), which do trigger normally.
- **GitHub Actions runners can sit queued for 45+ minutes with zero jobs
  created, for no diagnosable reason** (checked: Actions enabled, branch
  policy allows main, no pending approval, GitHub status page green).
  Happened once. Cancelling the stuck runs and re-triggering cleared it
  immediately. If it happens again, that's the first thing to try before
  assuming the workflow config is broken.
- **lightweight-charts v5 changed the series-creation API** from v4:
  `chart.addSeries(LightweightCharts.CandlestickSeries, options)`, not
  `chart.addCandlestickSeries(options)`. Price line labels
  (`createPriceLine({title: ...})`) render inline wherever the line is —
  usually right over the most recent candles. This project renders level
  *names* as a separate left-anchored DOM overlay instead (positioned via
  `priceToCoordinate()`), keeping `title` empty on every price line.
- **`series.update()` throws if fed a time older than the series' current
  last bar.** Hit this twice: once from a naive "last 2 rows" live-poll
  batch, once from resetting the monotonic-time guard to `null` on every
  chart switch (which disabled the guard for exactly the next poll). Fixed
  by seeding the guard with the actually-rendered last candle's time, never
  nulling it.
- **Label decluttering**: a naive forward-only cascade (push every
  overlapping label down from the topmost one) drifts badly on a short
  chart where several labels cluster near one edge — a label can end up
  tens of pixels from its real line. Fixed with a cluster-and-center
  algorithm (group overlapping labels, center each cluster on its own
  average position) plus a thin leader line connecting any visibly
  displaced label back to its true position.
- **Public GitHub repos get unlimited free Actions minutes** — nothing in
  this project should ever cost money. No server, no database, no paid
  API. If something looks like it's consuming a budget, something is
  configured wrong, it's not expected behavior.

---

## Run commands

```bash
python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt

python -m src.run --force        # level engine, writes site/data/
python -m src.backtest.cli       # scorecard, writes site/data/{asset}_scorecard.json
python -m pytest                 # full test suite
cd site && python3 -m http.server 8000   # view locally

gh workflow run update-levels.yml   # manual trigger of the real daily job
```

## Config (`config.py`)

Every tunable lives there with an inline comment — don't duplicate the
list here, it'll drift. Worth knowing the sections exist: Exchange,
Schedule, Volume profile, Swing pivots/golden pocket, Confluence,
Backtest/scorecard, Daily diff.
