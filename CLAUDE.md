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
  spy/                        # SPY exhaustion-reversal options backtest — Alpaca+Yahoo, not Kraken, own rules entirely
    fetch.py                   # Alpaca 5m SPY candles (~2y, needs ALPACA_API_KEY/SECRET) + Yahoo daily VIX
    heikin_ashi.py               # 5m -> 10m/15m/20m/30m resample (anchored to 9:30 ET) + HA transform
    exhaustion_signal.py          # doji/trend-wick signal detection, confluence count reported not assumed
    options_pricing.py             # Black-Scholes, VIX as an IV proxy — a model, not real quotes
    backtest.py                     # simulates the ATM 2-trading-day option to target/stop/expiry
    export.py                        # entry point: python -m src.spy.export — writes site/data/spy_*.json
    cli.py                            # entry point: python -m src.spy.cli — prints results, no JSON write
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
  **Follow-up**: the user came back and explicitly asked for the modeled
  heatmap anyway, understanding and accepting that it's a guess - see
  "Liquidation estimate" below for what got built once that was clear.
  The distinction that mattered wasn't "decline forever," it was "don't
  present a guess as verified fact without saying so" - once the user
  wanted the guess, clearly labeled, that's a legitimate ask.
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
- **Liquidation estimate** (`src/levels/liquidation_estimate.py`) — see
  the README section of the same name for the full methodology and the
  honesty framing; this is the implementation note. Reuses the volume
  profile's own `bin_edges`/`bin_volumes` (already computed from real
  trade data for POC/VAH/VAL, no extra fetch) and projects each bin
  through `LIQUIDATION_LEVERAGE_TIERS` (`config.py`: `[10, 25, 50, 100]`)
  into long/short liquidation prices, re-bucketed onto the same bin grid,
  normalized 0-1 server-side by the single hottest bin across both
  sides, capped to
  `LIQUIDATION_MAX_DISTANCE_PCT` (0.25) from current price. Output is
  `liquidation_estimate` in `{asset}_levels.json` - a flat list of
  `{price_low, price_high, long_intensity, short_intensity}`, computed
  once a day alongside everything else (no live recompute needed, same
  as POC/VAH/VAL).
  Rendered in `site/app.js` as two thin heat-strip columns
  (`renderLiquidationHeatmap`, called from inside `renderOverlays()` so
  it inherits the same staleness-fix machinery everything else there
  already has) docked against the price axis via
  `candleSeries.priceScale().width()` - deliberately **not** part of
  `currentMarkers`: there are 100+ bins, and treating them as
  clickable/decluttered "levels" the way real levels are would wreck
  that system and flood the table/dropdown. Purely a background visual,
  unaffected by isolate, same as the always-on current-price line.
  **A real debugging detour worth remembering**: the bars appeared
  completely invisible in every manual verification screenshot at
  first, even forced to `opacity:1` with a magenta background. Spent
  real effort chasing this as a z-index/paint-order bug (the chart's own
  canvas sits at `z-index: 2`) before finding the actual cause via a
  synchronous `getBoundingClientRect()` readback: the test viewport
  (1000px tall) was shorter than the chart container's page position
  (it starts ~455px down the page and is 720px tall, so its bottom
  edge sits past 1000px), and every verification screenshot happened to
  sample a bin that landed below the fold - never actually rendered content
  to begin with, nothing to do with the heatmap code. Fixed by testing
  with a taller viewport (1400px). The same class of bug bit chart-click
  testing earlier (see the isolate-on-click entry above) - **when a
  Playwright check against this page returns something false/invisible/
  absent, verify the element's actual page-absolute position against the
  viewport height before assuming the application code is wrong.**

  **That viewport finding was real but incomplete** - shipped it, then
  the user looked at the live site and still couldn't see it, with a
  screenshot to prove it. The viewport bug was one genuine problem;
  there was a second, separate one still live: intensity normalized
  against the single hottest bin across the *entire* +/-25% window means
  whatever's visible in a typical near-price view can be almost
  invisible whenever the all-time hottest zone happens to be scrolled
  off elsewhere (confirmed directly: the hottest bins that day sat
  ~10% below current price, so the view the user actually had open -
  close to current price - was showing bins at 10-20% of max opacity).
  Two more things were needed, found by directly reading back computed
  opacity + a pixel-level screenshot crop rather than assuming the first
  fix was sufficient: (1) `document.elementFromPoint` had also wrongly
  suggested a z-index/paint-order problem (bumped `.liquidation-bar` to
  `z-index: 3` just in case) - this turned out to be a red herring,
  because `elementFromPoint`/`elementsFromPoint` skip anything with
  `pointer-events: none` entirely, which every one of these bars has by
  design; they were never actually hidden by the canvas, hit-testing
  just can't see them. (2) The actual fix: `renderLiquidationHeatmap`
  now also rescales opacity against the max intensity among only the
  *currently visible* bins, not the server's global-window normalization
  - so the chart always shows its own on-screen hotspots at full visual
  strength. Also widened the bars (10px -> 16px) and raised the opacity
  ceiling (0.85 -> 0.9) for better baseline legibility. Confirmed
  visually this time with a direct pixel-crop screenshot showing a real
  green/red gradient, not just a DOM query returning non-null. **Lesson
  for next time: "the element exists in the DOM with a sane computed
  style" is not the same claim as "a human looking at this page would
  actually see it" - confirm the second one with an actual rendered
  screenshot, not a style readback, especially for anything opacity- or
  intensity-based.**
- **Redesigned as a real background heatmap after the visibility fix
  shipped.** The two-thin-columns-near-the-axis layout was a design
  mismatch, not a bug - the user sent a Coinglass-style reference
  screenshot (full-width horizontal color bands sitting behind the
  candles) and said a side strip "doesn't help." Rebuilt around that
  reference: `.liquidation-row` is now one full-width div per bin
  (`left:0; right:<axisWidth>`), one color per row (whichever side -
  long or short - has the higher intensity there) rather than two
  overlapping red+green tints, which read as visual mud rather than
  information. All rows render into a single `.liquidation-heatmap-layer`
  wrapper (created once, cached in `liquidationLayerEl`, reused across
  renders) with `filter: blur(10px)` - individual bins are only ~4px
  tall at typical zoom and without the blur looked like a stack of extra
  gridlines, not a heatmap; blurring blends neighbors into the soft,
  continuous gradient the reference image actually has. Also added
  `LIQUIDATION_MIN_OPACITY` (0.1) so cold areas still carry a faint tint
  instead of fading to nothing - a real heatmap colors its whole range,
  not just the hot spots. z-index stays below the chart's own canvas
  (`z-index: 0` vs the canvas's `2`) so candles/grid draw on top, exactly
  like the reference.
  **This still shipped invisible** - the user checked again and still saw
  nothing, with a fresh screenshot. Two real, separate bugs were layered
  on top of each other, found only by sampling actual rendered pixel RGB
  values (via a canvas `getImageData` on a real screenshot) instead of
  trusting DOM/computed-style readbacks, which had looked completely
  correct at every step:
  1. **`filter: blur()` was actively destroying the signal, not softening
     it.** A bin is only ~4px tall, mostly flanked by near-transparent
     neighbors; blurring a thin low-opacity strip spreads its color
     contribution across a much wider band, diluting the peak opacity at
     any single row to a sliver of its pre-blur value. Fixed by doing the
     smoothing in JS instead - `smoothValues()` box-averages the raw
     `long_intensity`/`short_intensity` arrays across
     `LIQUIDATION_SMOOTHING_RADIUS` (4) neighboring bins *before* any
     opacity is computed, so the number that ends up in `style.opacity`
     is the number that actually reaches the screen. The CSS filter is
     now `blur(1px)`, just enough to soften pixel-grid edges between
     already-smoothed rows.
  2. **The chart's own `layout.background` was a genuinely opaque fill,
     not merely "whatever candles happen to cover."** lightweight-charts
     paints this as a solid rect across the entire pane - at `z-index: 2`,
     unconditionally, before grid or candles - so *anything* below that
     z-index was permanently hidden, independent of where candles/grid
     actually drew. `elementFromPoint`/`elementsFromPoint` couldn't catch
     this either (same reason as before: they skip `pointer-events: none`
     elements, so the heatmap layer never appeared in that
     investigation regardless of what was really happening). Fixed by
     setting `background: { type: "solid", color: "rgba(0, 0, 0, 0)" }`
     instead of `cssVar("--surface")` - `#chart-container`'s own CSS
     background (already `var(--surface)`) still fills in everywhere
     nothing else draws, so this has no visible effect except finally
     letting the z-index: 0 heatmap layer show through.
  Confirmed this time by sampling real pixel colors at the exact
  page-coordinates of the DOM's own highest-opacity row and checking the
  math: predicted blend at opacity 0.55 against the dark background was
  ~[45, 118, 81]; the actual sampled pixel was [45, 117, 80]. **The
  standing lesson from this feature, reinforced twice now: DOM state,
  computed style, and `elementFromPoint` can all agree the element is
  correct while the screen genuinely shows nothing - for anything
  opacity/layering-based, the only real verification is reading back
  actual pixel colors from an actual screenshot, ideally checked against
  a hand-computed expected value, not just "a color appears somewhere."**
- **Dimmed and given contrast once it was actually visible.** With the
  two bugs above fixed, the next real problem was the opposite one: the
  whole range read as uniformly, loudly saturated - "blinding," and
  nothing stood out as more or less important. `LIQUIDATION_MAX_OPACITY`
  0.55 -> 0.32, `LIQUIDATION_MIN_OPACITY` 0.1 -> 0.035, and a new
  `LIQUIDATION_CONTRAST_EXPONENT` (2.2): `relative` is raised to this
  power before scaling into the opacity range, so a bin at 50% of the
  visible peak renders far dimmer than linear would (0.5^2.2 ≈ 0.22 of
  the way to max, not 50%) - true hotspots stand out against a quiet
  background instead of the whole view looking equally hot.
- **Position tracking: size, leverage, live P&L, and closing a trade.**
  The trade form gained two optional fields (`trade-form-size`,
  `trade-form-leverage`); a trade with both set gets a live P&L column in
  the trades table (`tradePnl()` in `site/app.js`), re-rendered every
  live poll tick the same way the nearest-level cards already are. Same
  mental model as the liquidation estimate: `size` is margin, `size x
  leverage` is notional, and liquidation price for a leveraged entry is
  the identical `entry * (1 -+ 1/leverage)` formula used there - this
  and the liquidation heatmap are really two views of the same math, one
  modeled from the crowd's volume, one entered by hand for one specific
  position.
  Closing a trade (the "Close" button, `closingTradeId` state +
  `confirmCloseTrade()`) freezes `tradePnl()`'s reference price at
  `trade.exitPrice` instead of the live price, permanently - confirmed
  directly by closing a trade, then waiting through a real 15s live poll
  tick and checking the P&L string was byte-identical before and after,
  not just inspecting the code. `closingTradeId` exists specifically so
  the inline exit-price input survives that same 15s re-render instead
  of vanishing out from under the user mid-entry (the table fully
  rebuilds its DOM on every render, same as every other table on this
  site). A closed trade also gets a second chart marker (a colored
  circle, green/red by whether it was a win) at its exit time, found and
  filtered independently from the entry marker's time since a long-open
  position's entry and exit can straddle a narrow timeframe's loaded-
  candle window differently.
- **"I don't even see the full life of Bitcoin on the daily chart" - a
  full visual audit, not a quick patch.** Investigated rather than
  assumed: confirmed directly that Kraken's public OHLC endpoint always
  returns just its most recent ~720 candles regardless of `since` (tried
  `since=1` and a 2020 date - both came back anchored to "now," never
  further back). There is no way to page past that on this endpoint, from
  the browser or a server - it's a hard wall on Kraken's side, not a CORS
  or pagination-logic problem. Checked several alternatives before
  settling: Binance is geo-blocked from this environment; CoinGecko's
  `market_chart` needs a paid key past 365 days (confirmed: `days=365`
  returns 200, `days=366` returns 401). Coinbase's public
  `/products/{id}/candles` endpoint (CORS-friendly, no key, confirmed
  directly) has real daily data back to 2015 (BTC-USD) / mid-2016
  (ETH-USD) and genuinely honors `start`/`end` for pagination, capped at
  300 candles/request (confirmed: a wider request comes back with an
  explicit `"Count of aggregations requested exceeds 300"` message, not a
  silent clamp). `fetchCoinbaseDailyHistory()` pages through that in
  parallel and merges with Kraken's own fetch, which still owns the
  live/most-recent end unchanged.
  Three more real, separate bugs turned up only by actually looking at
  the rendered result rather than assuming the data alone was the fix:
  - **`fitContent()` was silently clamping to ~2,100 of the 4,000+
    candles**, no error - traced to `minBarSpacing`'s default (0.5px),
    which physically caps how much history can ever fit in a given pixel
    width. Confirmed directly by reading back the actual visible logical
    range after a real load and seeing it stop partway through the data
    every time. Lowered to `0.05` in the chart's `timeScale` options.
  - **Years of real price history were visually invisible on a linear
    scale** - BTC/ETH moved through multiple orders of magnitude over
    this stretch, so anything before ~2020 rendered as a flat line
    hugging the bottom of the chart. `candleSeries.priceScale()` now
    switches to `PriceScaleMode.Logarithmic` specifically for `range ===
    "1d"` (reverted to `Normal` for every other timeframe, where it
    doesn't apply and would look wrong).
  - **The volume series was showing its own stray "latest value" label**
    (e.g. "3.27K") right in among the real price labels, from
    `lastValueVisible`'s default of `true` on every series - visible in
    the user's own screenshot but easy to miss as "just more clutter"
    without specifically asking what a number with no apparent price
    context was doing there. Set `lastValueVisible: false` on the volume
    series.
  Deep history is also deliberately **not awaited before the Daily view
  renders** - the first version blocked the whole chart on ~13 sequential
  Coinbase pages (several real seconds), during which Daily looked
  exactly like a frozen/broken view on every single switch, not just the
  first. `loadDeepDailyHistoryInBackground()` fires after the fast
  Kraken-only render already completed and pops the deeper history in
  once it's ready, confirmed directly: candle count was ~720 at 0.4s
  after switching to Daily, ~4,000+ by 6.4s.
- **SPY exhaustion-reversal options backtest** — the user asked to add SPY
  alongside BTC/ETH, but with its own rules entirely: they described a
  specific discretionary setup (Heikin-Ashi exhaustion doji after a trend,
  on 10m/15m/20m/30m, 10am-noon ET, ATM 2DTE option, +20%/-10%) and wanted
  it backtested for real odds, not turned into a live signal. See "SPY:
  exhaustion-reversal options backtest" in README.md for the full mechanics
  and honesty framing (Black-Scholes/VIX as a modeled premium rather than
  real quotes, confluence reported at every threshold rather than assumed).
  `src/spy/`, parallel structure to `src/levels/`/`src/backtest/` but
  talking to Alpaca (SPY bars) and Yahoo (VIX only) instead of Kraken.
  Three things worth remembering if this gets touched again:
  - **The first version ran on Yahoo's free intraday endpoint alone, capped
    at 60 days** (confirmed live - Yahoo truncates intraday history to a
    rolling window regardless of what's requested) - only 11 signals, too
    thin to trust. The user explicitly asked to fix the sample size, which
    meant a second data source: Alpaca's market data API gives real 5-minute
    bars back to 2016 on its free IEX feed, genuinely paginated via
    `next_page_token`, for a free API key (no funding/trading needed - see
    README's "Alpaca needs..." section for the exact setup). That took the
    sample from 11 signals to 152. One real gotcha hit getting there:
    Alpaca 403s with "subscription does not permit querying recent SIP
    data" unless `feed=iex` is passed explicitly - without it, the default
    feed is SIP, which free accounts can't query near "now" (confirmed
    live: the identical call succeeds for an all-past date range and fails
    only once `end` approaches the present).
  - **A real bug caught by writing tests, not by eyeballing the backtest
    numbers**: the wick-side check in `exhaustion_signal.py` was backwards
    on the first pass - checking the lower wick for an uptrend exhaustion
    and the upper wick for a downtrend one, the opposite of what "rejection
    at the top of an uptrend / bottom of a downtrend" actually means.
    Caught while hand-deriving the test fixtures (the expected wick didn't
    match the scenario being built), not by noticing the live backtest
    looked wrong - the before/after numbers (91.7%→72.7% stop rate) looked
    directionally plausible either way, which is exactly why a hand-traced
    test mattered more than eyeballing output here.
  - **`[hidden]` wasn't actually hiding anything** - toggling
    `el.hidden` on `#futures-context`, `#nearest-levels`, `#chart-legend`,
    etc. (to switch sections between the crypto and SPY views) silently did
    nothing, because those elements' own CSS already declares
    `display: flex/grid`, which beats the UA stylesheet's
    `[hidden] { display: none }` in the normal cascade. Confirmed by
    reading `el.hidden` (true, correct) right next to a screenshot still
    showing the BTC content (also real). This was a latent bug in the
    *existing* crypto-only code too (`futures-context`'s own show/hide was
    never actually proven broken because `context` happened to always be
    present) - fixed with one global `[hidden] { display: none !important; }`
    rule rather than patching each class.
  SPY has no live polling, unlike BTC/ETH's chart - Alpaca needs an auth
  header the browser can't send cleanly for a public static site, and
  Yahoo's chart endpoint (VIX only now) has no CORS header either
  (confirmed live, same way the Kraken Futures gap above was confirmed),
  so the chart/signals/backtest table are baked once per cron run
  (`python -m src.spy.export`, wired into the same
  `update-levels.yml` as the level engine) rather than ticking in the
  browser.
- **Alpaca secrets added to GitHub Actions, SPY export confirmed live in
  CI** (2026-10-11) - `gh secret set ALPACA_API_KEY`/`ALPACA_SECRET_KEY`
  from the local `.env`, then `gh workflow run update-levels.yml` and
  watched the run: the "Run SPY exhaustion-reversal backtest" step
  succeeded and `site/data/spy_chart.json` got a fresh CI-generated
  `generated_at_utc`, not the stale locally-committed one. The real
  ongoing-cost gate from here is just the normal public-repo free Actions
  minutes, same as BTC/ETH.
- **Trend/doji parameter sweep re-run against the real ~2-year Alpaca
  sample** (`src/spy/sweep.py`, new file, 2026-10-11) - the earlier sweep
  (see "Next up" history) ran against the thin 60-day Yahoo sample and had
  cells with as few as 3-5 trades, not trustworthy. Re-run as a 4x6 grid
  (`TREND_LOOKBACK` 2-5 × `DOJI_BODY_MAX_PCT` 0.15-0.40, step 0.05) against
  the full 41,661-candle/730-day sample, every cell landing at 73-212
  signals - comfortably past the 30-trade confidence bar used elsewhere in
  this project. Real findings, not assumed: `TREND_LOOKBACK=5` is
  uniformly the worst column at every doji width (-0.3% to -4.2% avg
  return); the prior default (`TREND_LOOKBACK=3`, `DOJI_BODY_MAX_PCT=0.30`)
  is flat-to-negative (-0.05%); `TREND_LOOKBACK=4`/`DOJI_BODY_MAX_PCT<=0.30`
  is the standout cell (150 resolved, 37.3% target-hit rate, +1.43% avg
  premium return) and is now the live default in
  `src/spy/exhaustion_signal.py`. Changing `TREND_LOOKBACK` meant updating
  `tests/test_spy_exhaustion_signal.py`'s hand-built fixtures too - they're
  traced by hand against the exact constant, so a 3-trend-candle fixture
  silently stops firing any signal once the code requires 4 (confirmed:
  `range(TREND_LOOKBACK, len(frame))` goes empty, not an error, so this
  would have been a silent false-negative in the test suite rather than a
  loud failure if left unfixed). The multi-timeframe confluence test needed
  its two synthetic frequencies changed too (10/15 -> 10/12) since the
  longer trend requirement pushed each frame's doji candle past
  `SIGNAL_CLUSTER_MINUTES` apart at the old spacing.
  **Explicitly not oversold**: this is the best of 24 tested cells on one
  sample - exactly the shape of result that tends to look better in-sample
  than out-of-sample. Treat "trend=4 is the better-supported choice" as the
  honest claim here, not "this is a proven edge." The deeper, separate
  finding that motivated re-running this in the first place still holds at
  the new default too: 2+ timeframe confirmation performs *worse* than 1+
  (18 trades, -6.30% avg return, vs. 150 trades at +1.43%) - more
  confluence is not better here, at trend=3 or trend=4 alike. That's a real
  pattern worth keeping in mind before any future UI change implies "more
  timeframes agreeing = more confident."

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
python -m src.spy.export         # SPY backtest, writes site/data/spy_*.json — needs ALPACA_API_KEY/SECRET (.env locally)
python -m src.spy.cli            # same backtest, prints the confluence table, writes nothing
python -m pytest                 # full test suite
cd site && python3 -m http.server 8000   # view locally

gh workflow run update-levels.yml   # manual trigger of the real daily job
```

## Config (`config.py`)

Every tunable lives there with an inline comment — don't duplicate the
list here, it'll drift. Worth knowing the sections exist: Exchange,
Schedule, Volume profile, Swing pivots/golden pocket, Confluence,
Backtest/scorecard, Daily diff.

- **Daily exhaustion-pattern detector for BTC/ETH** (`src/levels/exhaustion_pattern.py`,
  `src/backtest/exhaustion_pattern.py`, 2026-10-11) - built in direct response to the user
  asking (again) for a live BTC entry signal after seeing SPY's Call/Put markers and
  assuming they were real-time. They weren't (SPY is fully retrospective/batch - see the
  SPY section below) and the user explicitly wanted "when to go long or short." Declined
  that framing per the Product philosophy at the top of this file, with concrete evidence
  from the SPY sweep just finished (its best-of-24-cells edge is only +1.43% avg return,
  and *more* timeframe confirmation makes it perform *worse*, not better) - offered the
  same pattern-detection machinery reporting real historical frequency instead, which the
  user accepted.
  Same exhaustion-candle definition as SPY (`src/spy/exhaustion_signal.py`: a run of
  same-direction Heikin-Ashi candles followed by a doji whose rejection-side wick exceeds
  every preceding trend candle's range), but daily-only (no SPY-style intraday session or
  multi-timeframe confluence - there's no equivalent concept for BTC/ETH) and deliberately
  NOT importing from `src/spy/` - duplicated the ~15-line HA transform instead, keeping the
  two systems independent the same way the repo layout already treats them as fully
  separate (SPY: "own rules entirely"). `TREND_LOOKBACK=3`/`DOJI_BODY_MAX_PCT=0.30` here are
  explicit, labeled-as-such **generic defaults, not tuned for crypto** - SPY's swept
  trend=4 came from its own options-expiry economics and has no reason to transfer.
  Two pieces: `src/levels/exhaustion_pattern.py::detect_latest()` (live engine, once a day,
  "did the most recent closed daily candle itself qualify") feeds
  `{asset}_levels.json`'s new `exhaustion_pattern` key; `src/backtest/exhaustion_pattern.py`
  scans the full ~2yr daily history once (no day-by-day replay needed - unlike
  POC/VAH/VAL, each candle's qualification only looks at its own fixed small backward
  window, so it's already point-in-time correct without re-simulating per day) and reuses
  the **exact same output shape** as a level-type scorecard entry (`touches`/`resolved`/
  `hold_rate_pct`/etc.), so it drops straight into `{asset}_scorecard.json` as a new
  "Exhaustion pattern" row and renders in the existing table with zero site changes -
  same trick "Round number" already uses despite not being a real level either.
  First real run: BTC and ETH both currently show **no pattern detected** (expected -
  this is a specific, somewhat rare candle shape, not a "levels exist somewhere" kind of
  feature) with only 12 historical occurrences each over the ~2-year window (58.3% /
  50.0% reversal rate, both explicitly flagged low-confidence at n=12 vs. the 30-touch
  bar) - an honest small sample, not hidden.
  New site element: `#exhaustion-banner` (hidden whenever nothing's detected, or on the
  SPY view), styled bullish/bearish via the existing `--support`/`--resistance` CSS
  variables. Explicitly worded to avoid call-to-action framing ("not a signal, read the
  odds yourself") and never says "buy"/"sell"/"enter." This is still a once-a-day-cadence
  feature like every other level, not live-ticking every 15s like price/order-book - said
  plainly to the user rather than oversold as "live."
  `tests/test_exhaustion_pattern.py` mirrors the SPY test file's structure (hand-built HA
  rows for the core logic, bypassing the recursive real-OHLC conversion) but needed one
  extra real-OHLC-path test since `to_heikin_ashi`'s HA close averages in the WHOLE real
  candle - a long wick alone doesn't produce a small HA body; the opposite side has to
  snap back past the open to counteract the wick's pull on the average. That test fixture
  required numerically iterating a hammer/shooting-star candle shape rather than a simple
  formula, confirmed directly by printing the intermediate HA frame rather than
  hand-deriving it.

## Next up (as of 2026-10-11)

SPY's exhaustion-reversal backtest is built, tested, and **now live**: the
Alpaca secrets are in GitHub Actions, `update-levels.yml`'s SPY export step
has been confirmed succeeding end-to-end in real CI (not just locally), and
the trend/doji parameter sweep below has been re-run against the real
sample and adopted as the new default.

1. **Real options quotes are still an open question** - the user wanted to
   check whether ThinkOrSwim OnDemand could supply actual historical SPY
   options chains instead of the Black-Scholes/VIX model. Last status: it
   looks like an interactive replay tool, not a bulk-export feature, so
   this is probably blocked without a paid data source (Polygon/Databento)
   unless the user has a path I don't know about. Ask before assuming
   either way.
2. Watch `site/data/spy_chart.json`'s size over the next few real cron
   runs (committed every ~3h) - it's ~750KB now at 60 display days; if it
   creeps up, revisit `CHART_DISPLAY_DAYS` in `src/spy/export.py` before
   repo size becomes its own problem.
