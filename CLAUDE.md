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
    round_numbers.py           # psychological whole-number levels, scaled to price magnitude
    confluence.py             # merges nearby levels, tags type/distance/strength
    daily_diff.py              # new/moved/unchanged/removed vs. the prior snapshot
    engine.py                  # orchestrates all of the above per asset (live, 4h+daily)
  backtest/
    engine.py                 # daily-candle-only approximation of the level engine, for replay depth
    replay.py                  # day-by-day replay with the no-lookahead guarantee
    outcomes.py                 # touch/hold/break classification for one level
    scorecard.py                 # aggregates outcomes per level type per asset
    round_proximity.py           # hold rate at 6 tolerance tiers around a round number
    cli.py                        # entry point: python -m src.backtest.cli
  context/
    futures.py                 # open interest + funding rate, server-side (no CORS on Kraken's side)
tests/                        # hand-built fixtures + one real-Kraken-response fixture
site/
  index.html / styles.css / app.js   # live chart (polls Kraken directly) + renders levels/scorecard/diff/trades
  data/                       # JSON the Action writes; the page reads levels/scorecard from here
    history/{btc,eth}/YYYY-MM-DD.json   # one snapshot per day, feeds daily_diff
.github/workflows/
  update-levels.yml          # daily cron: level engine + backtest + commit + Pages deploy, all one job
  deploy-pages.yml           # redeploys Pages on a direct push to site/** (editing the site by hand)
```

Trade journal (`site/app.js`) saves to the browser's localStorage, not the
repo — there's nothing server-side to list here for it.

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
| Context strip: funding rate + open interest | ✅ Built. `src/context/futures.py`, server-side (daily job), no CORS on the browser side. |
| Context strip: 10Y yield, BTC dominance | ❌ Not built — needs new free data sources, not yet researched. |

Also built, beyond the original Phase 1/2 spec, in response to live usage:
- **Live chart**, independent of the daily snapshot — 1m/5m/15m/30m/1h/4h/Daily
  timeframes, all polling Kraken directly every 15s, with retry+backoff.
- **Nearest-level cards** — nearest resistance/support/round-number to the
  live price, each with its aggregated historical hold rate, right next
  to the price. This came from the user repeatedly asking for an entry
  signal (see Product philosophy above) — the honest answer each time
  was "here are the real odds," not a signal.
- **Round numbers** (`src/levels/round_numbers.py`) — psychological
  whole-number levels, scaled to price magnitude, tested through the
  backtest same as everything else. Proven, not assumed: BTC round
  numbers held 46.3% (n=626, tested across 90 distinct values from $58k
  to $120k), ETH held 56.5% (n=579, 28 distinct values) - both with real
  sample size, using a tolerance-zone touch definition (within a
  quarter-step, not an exact print) after the user clarified that's what
  "getting close to a whole number" actually means in practice.
- **Round-number proximity curve** (`src/backtest/round_proximity.py`) -
  the user asked to "find a pattern" in how the odds shift as price gets
  closer to a round number, not just one aggregate hold rate. Real,
  substantial, monotonic finding: hold rate drops the closer price
  actually gets (BTC 55%→42%, ETH 69%→40%, from a full step away down to
  2%, 600+ resolved touches at every tier for both assets). Read: a loose
  approach often reverses before fully arriving; once price actually
  commits and reaches the number closely, continuation becomes more
  likely than a bounce right at the number. Shown on the live chart as 3
  nested bands around the current nearest round number (not all 6 tiers -
  picked loose/mid/tight to stay readable), reusing the existing
  zone-overlay system via a new `opacity` field per marker.
- **Order book liquidity walls** — the user asked for "where all the
  liquidity is sitting" / a liquidation heatmap. Researched this
  directly rather than guessing: a true liquidation heatmap needs every
  trader's entry price and leverage across every exchange, which no
  exchange publishes - the tools that show one (Coinglass, Hyblock) are
  displaying a model's estimate, not verified data. Declined to fake
  that. Built the real thing instead: Kraken's public spot order book
  (`/0/public/Depth`, CORS-friendly, confirmed live) shows actual resting
  bids/asks right now. `fetchOrderBookWalls` in `site/app.js` takes the
  top 3 per side that are at least 2x the book's median size, polled on
  the same 15s cadence as the live candle, rendered as thin teal lines
  with size labels. Kraken Futures' open-interest/funding endpoint
  (`futures.kraken.com/derivatives/api/v3/tickers`) has **no CORS header
  at all** (checked the raw response headers directly) - not fetchable
  live from the browser, so it's a separate feature (below), fetched
  server-side once a day instead of polled live.
- **Futures context** (`src/context/futures.py`) — open interest + perp
  funding rate, fetched server-side in the daily job (the CORS gap above)
  and baked into `{asset}_levels.json` as `futures_context`, read directly
  off the already-loaded levels JSON with no extra client fetch. Real unit
  gotcha caught before shipping: the ticker's `fundingRate` field is
  **not a percentage** - it's BTC-per-$1-contract-per-hour; using it
  directly would have shown a nonsensical ~60% "funding rate" instead of
  the real ~0.0008%. `relativeFundingRate` is the field exchanges actually
  display as "the funding rate" (verified against Kraken's own docs and a
  live response). Also: Kraken Futures pays funding **hourly**, not every
  8h like most exchanges - labeled explicitly on the site so it doesn't
  get misread against an 8h mental model.
- A refresh button next to the levels timestamp — re-fetches without a
  full reload. Explicitly does NOT trigger new computation (the site is
  static, no server) - see the daily-run gating gotcha below for what
  actually needed fixing when the data went stale.
- Left-anchored level labels with a cluster-and-center decluttering
  algorithm (see gotchas below) instead of inline price-line titles.
- **Snap-to-level** — clicking any row in the Level table zooms the chart's
  price axis to frame that level tightly; clicking the same row again (or
  another row) restores the default view. `levelKey`/`snapToLevel`/
  `clearPriceSnapState`/`resetPriceSnap` in `site/app.js`. The "restore"
  side had a real bug worth remembering: `priceScale().setAutoScale(true)`
  only changes behavior going forward, it does **not** retroactively
  recompute an already-manually-set visible range, so un-snapping looked
  stuck until the price range was explicitly recomputed. The fix needed a
  second, non-obvious finding: `getVisibleRange()`/`setVisibleRange()` deal
  in bare data values only — the chart's configured `scaleMargins` (used to
  leave room for the volume series under the candles) pad the rendering,
  but are never reflected in the from/to numbers. Confirmed directly:
  autoscale's own `getVisibleRange()` matched the visible candles' raw
  high/low exactly, zero padding. An earlier attempt that added a flat
  margin before calling `setVisibleRange` was solving a problem that didn't
  exist and produced a visibly wrong (too-wide) restore.
- **Manual trade price entry** — the trade journal originally only accepted
  a price by clicking the chart; added a plain number input next to
  "+ Mark trade" (`trade-manual-price`/`trade-manual-btn`, Enter key also
  works) for typing the exact fill price instead. A typed entry has no
  associated chart bar, so it's stamped with the current time rather than
  a candle time — same canonical-unix-timestamp storage as a clicked trade.
- **Level-jump dropdown with a live progress percentage** — a `<select>`
  (`level-jump-select`) listing every row from the Level table, sorted by
  distance from the live price (closest first), that snaps the chart to
  whichever one is picked - kept in sync both ways with the table via one
  shared `toggleLevelSnap`/`syncLevelSelectionUi` path, so clicking a table
  row updates the dropdown and vice versa. Each option also shows a live
  percentage: 0% means price is sitting at the nearest level on the
  *opposite* side (the one it would cross back through first), 100% means
  price has arrived at this one. Explicitly anchored on the two real
  levels price is actually between (`findNearestAboveBelow`, shared with
  the nearest-level cards), not an arbitrary cutoff — generalizes the
  round-number proximity curve's "closer = higher percentage" idea to
  every level type. Returns `null` (no percentage shown) rather than
  inventing a reference point when price is beyond every known level in
  that direction (e.g. below the 60-day range low) and no opposite-side
  anchor exists.
- **Fixed label overlays going stale/disconnected after a price-axis
  change.** Reported with a screenshot showing every label's colored tag
  floating with no visible line near it. Root cause, confirmed directly
  rather than assumed: `candleSeries.priceScale().getVisibleRange()`/
  `priceToCoordinate()` happily return values far outside
  `[0, containerHeight]` for a level whose real price is beyond whatever's
  currently zoomed into view, and `chart.timeScale().subscribeVisibleLogicalRangeChange(renderOverlays)`
  only fires on a *time*-axis change - there's no equivalent price-scale
  event in this library version (checked the v5.2.1 typings directly:
  `IPriceScaleApi` has no subscribe method at all). Two changes needed:
  (1) `snapToLevel()` and `resetPriceSnap()` now call `renderOverlays()`
  themselves right after changing the price scale, since the native
  axis price tags the library draws are always correct (it redraws those
  itself) but our own `.level-label` divs are positioned by JS that only
  runs when something tells it to; (2) since the price axis can also be
  dragged/scroll-zoomed directly by the user (enabled by default, no
  event to hook), `ensureChart()` now polls `getVisibleRange()` every
  200ms and calls `renderOverlays()` only when it actually changed - cheap
  when nothing moved, confirmed working with a real `page.mouse` drag on
  the price axis in a Playwright test, not just a programmatic shortcut.
  Also added: a level whose true position lands outside the visible
  range now gets a `↑`/`↓` prefix on its label and its leader's
  target clamped to the nearest edge, rather than drawing a connector
  toward a line that was never going to be on screen.
- **Every on-chart label is now clickable, not just table rows.** The
  user asked for the labels themselves ("these buttons") - including
  order book walls and round-number proximity bands, not just formal
  levels - to snap the chart on click, on any timeframe. Generalized the
  snap machinery: `snapToLevel(level)` became `snapToRange(low, high)`,
  `toggleLevelSnap(level)` is now a thin wrapper over
  `toggleMarkerSnap(key, low, high)`, and `snappedLevelKey` is
  `snappedMarkerKey` everywhere. Every marker pushed into `currentMarkers`
  (formal levels, order book walls, proximity bands) now carries a `key` -
  `levelKey(level)` for levels, `` `wall|${side}|${price}` `` for walls,
  `` `proximity|${fraction}|${nearestRoundPrice}` `` for bands - so the
  exact same toggle used by the table and dropdown works from a direct
  click on the tag. Required removing `.level-label`'s `pointer-events:
  none` (it was fully inert before); verified directly with a real
  `page.mouse` pan gesture dragged across label territory that this
  didn't break chart panning/zooming. Walls and bands aren't in the table
  or dropdown (by design, see the dropdown-scope decision above), so
  clicking one just doesn't match any table row or dropdown option -
  confirmed that degrades cleanly rather than erroring.
  **Known flake, not caused by this change**: an automated label-order
  check (`verify_order2.js`-style, sorts all labels by pixel position and
  asserts price order matches) intermittently shows one violation -
  reproduced maybe 1 in 10-15 runs, always during a pan while live order
  book data was mid-update, never on a clean page load. Ruled out the
  obvious suspect directly: a real `page.mouse` drag across now-clickable
  labels still pans correctly (logical range moves exactly as expected).
  12+ dedicated repro attempts couldn't pin down the exact marker
  configuration that triggers it. Best guess: a rare residual edge case
  in `declutter()`'s cluster-centering (the one confirmed inversion bug
  in this function was already found and fixed earlier - see above - but
  live order-book prices constantly reshuffle which markers cluster
  together, so the input space to this function is effectively unbounded
  and a different rare configuration could still trip something similar).
  Not chased further since it's pre-existing and separate from what was
  being built. Worth a closer look if it starts showing up more.
- **Isolate-on-click**, in response to a screenshot of a sharp-drop view
  where order book walls had stacked up only a few dollars apart - the
  user asked to be able to click a line and have it isolated (everything
  else hidden) with its info shown, click again to bring everything back.
  Built on the same `snappedMarkerKey` state the snap/zoom already uses,
  so it's automatic from the table, the dropdown, or a direct chart-label
  click - no separate toggle needed. Two things had to hide, tracked
  differently: our own overlay DOM (labels, leaders, zone bands) just
  isn't built for non-selected markers in `renderOverlays()` (filtered
  before decluttering even runs); the *native* price lines the library
  draws itself needed `levelLinesByKey`/`wallLinesByKey` (IPriceLine
  objects keyed by the same marker key) and a new `applyLineIsolation()`
  that toggles `lineVisible`/`axisLabelVisible` per line, called at the
  top of every `renderOverlays()` so it's always in sync. The always-on
  live-price line (not a "level", just market context) deliberately isn't
  part of either map, so it stays visible even while isolated.
  Also audited that screenshot directly for a separate bug rather than
  assuming the clutter was the only thing wrong: reproduced the same
  label density (zoomed to roughly the same visible price band) and ran
  the existing overlap/order-violation checks against it - zero overlaps,
  zero order violations. The density itself was real, live order-book
  data, not a rendering bug - isolate is the actual fix for it.
- **Three follow-ups from a later screenshot** ("ARE THESE ------ lines
  representing something?" / "I have no idea what this line is"):
  - **The mystery dashed line was the chart library's own default
    crosshair** - confirmed directly by reproducing it (move the mouse,
    screenshot, compare pixel-for-pixel against the user's screenshot):
    lightweight-charts' default horizontal crosshair is gray,
    `LargeDashed`, with its own price tag, sitting wherever the mouse
    last was - close enough to our colored level tags to genuinely pass
    for one, and it carries no information our own current-price line
    doesn't already give. Turned off via `crosshair: { horzLine: {
    visible: false, labelVisible: false } }` in the chart options; the
    vertical (time) crosshair line stays, since it's unambiguous.
  - **Tags for off-screen levels are gone, not arrowed.** The earlier
    `↑`/`↓` off-screen-arrow system (see above) was itself a source of
    "what is this" confusion once isolate existed - the user explicitly
    asked to only see a tag when its line is actually on screen.
    `markerIsVisible()` checks a marker's real `[low, high]` against the
    container bounds (not just its midpoint, so a wide zone that's only
    partly scrolled into view still counts) and filters it out of
    `renderOverlays()` entirely otherwise - no placeholder, no arrow.
  - **Every line is now clickable along its whole length, not just its
    tag.** Decluttering routinely pushes a tag's label well away from its
    real line, so the old "click the tag" model left the line itself
    inert. `findMarkerNearPoint(y)` (used by both `handleChartClick` and
    a new `subscribeCrosshairMove` hover handler for cursor feedback)
    converts a small pixel tolerance to a price tolerance at the current
    zoom level - not a fixed price window, which would be huge zoomed out
    and useless zoomed in - and finds whichever marker's line is closest,
    treating a zone marker as a hit anywhere inside `[low, high]`, not
    just its two boundary lines. Isolation-aware: once a marker is
    isolated, every other line is actually hidden, so `findMarkerNearPoint`
    also skips them - nothing to click if there's nothing drawn.
    `handleChartClick` now branches on `markingMode` first so marking a
    trade still takes priority over isolating a line - confirmed directly
    with a test that clicks on top of a level while marking mode is
    active and checks the trade form opens, not an isolate.
    One real test-only gotcha hit while verifying the toggle-off path:
    `snapToRange`'s `setVisibleRange` transition isn't instant -
    `priceToCoordinate` read immediately after it can reflect a
    transitional, not-yet-settled position. Clicking at that
    not-yet-final pixel misses. Not a real bug (a human watches the
    chart settle before clicking), but worth remembering before
    trusting a fast re-click in an automated test against this chart.

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
- **GitHub's scheduled-workflow cron fired 6-9 hours late on consecutive
  days** — confirmed in the logs, not a one-off (a firing scheduled for
  10:00/11:00 UTC actually executed at 17:00 UTC). `src/run.py` used to
  gate on "is it exactly the 5am Central hour right now," which meant a
  late firing checked the clock, saw it wasn't 5am, and skipped - forever,
  every day, since no firing ever happened to land in that one exact hour.
  The site sat silently stale for ~32 hours before the staleness banner
  got noticed. Fixed by gating on "has this asset already produced
  today's data" instead (`_already_ran_today` in `src/run.py`) - whichever
  firing lands first each day does the real work, regardless of hour, and
  it's self-healing if a whole day's firings get skipped. Also widened the
  cron schedule from 2 firings/day to 8 (every 3 hours) as a margin
  against the jitter, since extra firings are now free no-ops. If daily
  data goes stale again, check `gh run list --workflow=update-levels.yml`
  for *when* runs actually fired before assuming the workflow logic broke
  - it's happened at least once already.

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
