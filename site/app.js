(function () {
  "use strict";

  const STALE_HOURS = 26;
  const LIVE_POLL_MS = 15000;
  const KRAKEN_OHLC_URL = "https://api.kraken.com/0/public/OHLC";
  const KRAKEN_DEPTH_URL = "https://api.kraken.com/0/public/Depth";
  const ASSET_PAIRS = { btc: "BTC/USD", eth: "ETH/USD" };
  // the candle price scale reserves extra room at the bottom for the volume
  // series beneath it, so "fit these candles" must reproduce this same
  // asymmetric split - a flat symmetric margin visibly doesn't match what
  // autoscale actually renders.
  const CANDLE_SCALE_MARGINS = { top: 0.08, bottom: 0.3 };
  const RANGE_INTERVALS = { "1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240, "1d": 1440 };

  const state = {
    asset: "btc",
    range: "4h",
  };

  function readHash() {
    const params = new URLSearchParams(location.hash.replace(/^#/, ""));
    if (params.get("asset") === "eth") state.asset = "eth";
    const range = params.get("range");
    if (range && RANGE_INTERVALS[range]) state.range = range;
  }

  function writeHash() {
    const params = new URLSearchParams();
    params.set("asset", state.asset);
    params.set("range", state.range);
    history.replaceState(null, "", "#" + params.toString());
  }

  function isDark() {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // --- data fetching ---

  async function fetchJson(path) {
    const res = await fetch(path, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
    return res.json();
  }

  function levelsUrl(asset) {
    return `data/${asset}_levels.json`;
  }

  function scorecardUrl(asset) {
    return `data/${asset}_scorecard.json`;
  }

  function proximityUrl(asset) {
    return `data/${asset}_round_proximity.json`;
  }

  // The chart (candles) is always fetched live, straight from Kraken -
  // only the levels come from the once-a-day static snapshot. Shared by
  // the initial render and the live poll below.
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Kraken (behind Cloudflare) will occasionally fail a request with no
  // CORS header at all - observed in practice after a burst of requests
  // in a short window (e.g. clicking through several timeframes quickly,
  // on top of the live poll's own requests). A plain fetch failure like
  // that is usually gone on the very next attempt, so retry with a short
  // backoff before surfacing it as a real failure - same pattern as the
  // daily engine's own fetch_candles() retry on the Python side.
  async function fetchKrakenCandles(pair, interval, retries = 3) {
    let lastErr;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const url = `${KRAKEN_OHLC_URL}?pair=${encodeURIComponent(pair)}&interval=${interval}&assetVersion=1`;
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`Kraken OHLC fetch failed: ${res.status}`);
        const payload = await res.json();
        if (payload.error && payload.error.length) throw new Error(`Kraken error: ${payload.error.join(", ")}`);
        const rows = payload.result && payload.result[pair];
        if (!rows) throw new Error("Kraken response missing expected pair data");
        return rows.map((row) => ({
          time: row[0],
          open: +row[1],
          high: +row[2],
          low: +row[3],
          close: +row[4],
          volume: +row[6],
        }));
      } catch (err) {
        lastErr = err;
        if (attempt < retries - 1) await sleep(600 * (attempt + 1));
      }
    }
    throw lastErr;
  }

  // Real resting orders on Kraken's spot order book right now - the
  // literal answer to "where is liquidity sitting," not a modeled
  // estimate. (A true liquidation heatmap - where leveraged positions
  // would get force-closed - needs every trader's entry price and
  // leverage across every exchange; no exchange publishes that, and the
  // tools that show one are displaying a model's guess, not verified
  // data. This is the real thing instead: actual bids and asks.)
  const ORDER_BOOK_WALL_COUNT = 3; // top N per side shown
  const ORDER_BOOK_WALL_MIN_SIZE_MULTIPLE = 2; // must be at least this many times the book's median size

  async function fetchOrderBookWalls(pair, retries = 3) {
    let lastErr;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const url = `${KRAKEN_DEPTH_URL}?pair=${encodeURIComponent(pair)}&count=100`;
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`Kraken Depth fetch failed: ${res.status}`);
        const payload = await res.json();
        if (payload.error && payload.error.length) throw new Error(`Kraken error: ${payload.error.join(", ")}`);
        const book = payload.result && payload.result[pair];
        if (!book) throw new Error("Kraken response missing expected pair data");

        const parse = (rows) => rows.map(([price, volume]) => ({ price: +price, volume: +volume }));
        const bids = parse(book.bids);
        const asks = parse(book.asks);

        const median = (rows) => {
          const sorted = [...rows].map((r) => r.volume).sort((a, b) => a - b);
          return sorted[Math.floor(sorted.length / 2)];
        };
        const significantWalls = (rows, side) => {
          const threshold = median(rows) * ORDER_BOOK_WALL_MIN_SIZE_MULTIPLE;
          return [...rows]
            .filter((r) => r.volume >= threshold)
            .sort((a, b) => b.volume - a.volume)
            .slice(0, ORDER_BOOK_WALL_COUNT)
            .map((r) => ({ ...r, side }));
        };

        return { bids: significantWalls(bids, "bid"), asks: significantWalls(asks, "ask") };
      } catch (err) {
        lastErr = err;
        if (attempt < retries - 1) await sleep(600 * (attempt + 1));
      }
    }
    throw lastErr;
  }

  // --- chart ---

  let chart = null;
  let candleSeries = null;
  let volumeSeries = null;
  const activePriceLines = [];
  const orderBookPriceLines = []; // separate from activePriceLines - these redraw every poll tick, not just on load/toggle
  const overlayEls = [];
  let currentMarkers = []; // {key, low, high, mid, color, label, isZone} for repositioning on redraw
  // native IPriceLine objects, keyed by the same marker key, so "isolate"
  // can toggle lineVisible/axisLabelVisible per line instead of per marker
  // array - kept separate (levels refresh once per data load, walls every
  // poll tick) so refreshing one never has to touch the other's entries.
  let levelLinesByKey = new Map();
  let wallLinesByKey = new Map();
  let lastLiveUnixTime = null; // guards against feeding series.update() a time older than its last bar

  // the daily levels + scorecard, kept around so the nearest-level cards
  // can be recomputed on every live price tick, not just on load/toggle.
  let activeLevels = [];
  let activeScorecard = null;
  let activeProximity = null;
  let activeLiquidationBins = []; // {price_low, price_high, long_intensity, short_intensity} - a model, not real position data, see renderLiquidationHeatmap()
  const liquidationEls = []; // kept separate from overlayEls - purely visual, never clickable/decluttered/part of currentMarkers
  let tradeMarkersPlugin = null;
  let activeCandles = []; // current timeframe's loaded candles, so trade markers can be bounds-checked
  let markingMode = false;
  let pendingTrade = null; // {time, price} captured from a chart click, awaiting form submission
  let snappedMarkerKey = null; // key of whichever marker (table row, dropdown pick, or on-chart label) the price scale is currently locked to, if any
  let activeLevelsWindowDays = null; // RANGE_DAYS from the levels JSON, for the 4H default-zoom calc
  let lastOverlayPriceRange = null; // {from, to} as of the last renderOverlays() call, for the price-scale poll below

  function ensureChart() {
    if (chart) return;
    const container = document.getElementById("chart-container");
    chart = LightweightCharts.createChart(container, {
      autoSize: true,
      layout: {
        background: { type: "solid", color: cssVar("--surface") },
        textColor: cssVar("--text"),
      },
      grid: {
        vertLines: { color: cssVar("--border") },
        horzLines: { color: cssVar("--border") },
      },
      // The library's default horizontal crosshair line (gray, large-
      // dashed, with its own price tag) sits wherever the mouse last was
      // and looks close enough to our own colored level tags to pass for
      // one - a real source of "what is this line?" confusion, confirmed
      // by reproducing it directly. It adds no information our own
      // current-price line doesn't already give, so it's off; the
      // vertical (time) crosshair line stays, it's unambiguous.
      crosshair: { horzLine: { visible: false, labelVisible: false } },
      timeScale: { timeVisible: true, borderColor: cssVar("--border") },
      rightPriceScale: { borderColor: cssVar("--border") },
    });

    candleSeries = chart.addSeries(LightweightCharts.CandlestickSeries, {
      upColor: cssVar("--support"),
      downColor: cssVar("--resistance"),
      borderVisible: false,
      wickUpColor: cssVar("--support"),
      wickDownColor: cssVar("--resistance"),
      priceScaleId: "right",
      scaleMargins: CANDLE_SCALE_MARGINS,
      // a persistent "where is price right now" line, always visible -
      // its own color + dotted style keeps it visually distinct from the
      // solid support / dashed resistance / large-dashed flip lines.
      priceLineVisible: true,
      priceLineColor: cssVar("--accent"),
      priceLineWidth: 1,
      priceLineStyle: LightweightCharts.LineStyle.Dotted,
    });

    volumeSeries = chart.addSeries(LightweightCharts.HistogramSeries, {
      color: cssVar("--text-muted"),
      priceFormat: { type: "volume" },
      priceScaleId: "",
    });
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

    tradeMarkersPlugin = LightweightCharts.createSeriesMarkers(candleSeries, []);
    chart.subscribeClick(handleChartClick);
    // hover feedback for "click the line itself" - the cursor becomes a
    // pointer only when it's actually close enough to a drawn line to do
    // something, so you can tell before you click rather than guessing.
    chart.subscribeCrosshairMove((param) => {
      if (markingMode) return; // marking-mode already has its own cursor/hint via mark-trade-hint
      const near = param.point ? findMarkerNearPoint(param.point.y) : null;
      container.style.cursor = near ? "pointer" : "default";
    });

    chart.timeScale().subscribeVisibleLogicalRangeChange(renderOverlays);
    window.addEventListener("resize", renderOverlays);

    // The library has no price-scale equivalent of
    // subscribeVisibleLogicalRangeChange, so a manual drag or scroll-zoom
    // on the right price axis (enabled by default) changes the price
    // scale with no event to hook - every label would otherwise go stale,
    // pointing at wherever its line used to be rather than where it is
    // now. Poll for drift instead: cheap when nothing changed (two number
    // reads), only rebuilds the DOM when the range actually moved.
    setInterval(() => {
      if (!candleSeries || !lastOverlayPriceRange) return;
      const range = candleSeries.priceScale().getVisibleRange();
      if (!range) return;
      if (range.from !== lastOverlayPriceRange.from || range.to !== lastOverlayPriceRange.to) {
        renderOverlays();
      }
    }, 200);
  }

  function clearPriceLines() {
    for (const line of activePriceLines) {
      candleSeries.removePriceLine(line);
    }
    activePriceLines.length = 0;
    levelLinesByKey.clear();
  }

  // "Isolate": when a marker is snapped, every OTHER native price line
  // (the ones lightweight-charts draws itself - our overlay divs are
  // handled separately, by just not building them in renderOverlays())
  // hides too, so the chart shows only the one line being focused on.
  // Clicking again (snappedMarkerKey back to null) restores every line.
  function applyLineIsolation() {
    for (const map of [levelLinesByKey, wallLinesByKey]) {
      for (const [key, lines] of map) {
        const visible = !snappedMarkerKey || key === snappedMarkerKey;
        for (const line of lines) line.applyOptions({ lineVisible: visible, axisLabelVisible: visible });
      }
    }
  }

  function clearOverlays() {
    for (const el of overlayEls) el.remove();
    overlayEls.length = 0;
    currentMarkers = [];
  }

  function styleForLevel(level) {
    if (level.is_flip) {
      return { color: cssVar("--flip"), lineStyle: LightweightCharts.LineStyle.LargeDashed, lineWidth: 3 };
    }
    if (level.type === "support") {
      return { color: cssVar("--support"), lineStyle: LightweightCharts.LineStyle.Solid, lineWidth: 2 };
    }
    return { color: cssVar("--resistance"), lineStyle: LightweightCharts.LineStyle.Dashed, lineWidth: 2 };
  }

  // Every label embeds its own price, not just the compact axis tag -
  // at high density a label can get pushed well away from its true line
  // (see the bounds-clamping note in declutter() below), so the price
  // needs to be readable from the tag's own text, not just its position.
  function formatPriceRange(low, high) {
    const fmt = (v) => v.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return high > low ? `${fmt(low)}–${fmt(high)}` : fmt(low);
  }

  function renderLevels(levels) {
    clearPriceLines();
    clearOverlays();

    for (const level of levels) {
      const style = styleForLevel(level);
      const isZone = level.price_high > level.price_low;
      const label = `${level.name} (${level.strength}) — ${formatPriceRange(level.price_low, level.price_high)}`;
      const key = levelKey(level);

      // No inline title on the price line itself - that label renders
      // wherever the line is, which is usually right where the latest
      // (most interesting) candles are, burying exactly the price action
      // you want to compare it against. The compact price tag stays on
      // the right axis; the name instead renders as a left-anchored
      // overlay (below) so the line, and where it crosses candles, stays
      // visible across the whole chart width.
      if (isZone) {
        const top = candleSeries.createPriceLine({
          price: level.price_high,
          color: style.color,
          lineWidth: style.lineWidth,
          lineStyle: style.lineStyle,
          axisLabelVisible: true,
          title: "",
        });
        const bottom = candleSeries.createPriceLine({
          price: level.price_low,
          color: style.color,
          lineWidth: style.lineWidth,
          lineStyle: style.lineStyle,
          axisLabelVisible: true,
          title: "",
        });
        activePriceLines.push(top, bottom);
        levelLinesByKey.set(key, [top, bottom]);
      } else {
        const line = candleSeries.createPriceLine({
          price: level.price_low,
          color: style.color,
          lineWidth: style.lineWidth,
          lineStyle: style.lineStyle,
          axisLabelVisible: true,
          title: "",
        });
        activePriceLines.push(line);
        levelLinesByKey.set(key, [line]);
      }

      currentMarkers.push({
        key,
        low: level.price_low,
        high: level.price_high,
        mid: (level.price_low + level.price_high) / 2,
        color: style.color,
        label,
        isZone,
      });
    }

    renderOverlays();
  }

  const LABEL_MIN_GAP_PX = 20; // tags closer than this get pushed apart
  const LINE_CLICK_TOLERANCE_PX = 5; // how close a click has to land to a line to count as clicking it

  // Resolves overlaps by clustering nearby labels and centering each
  // cluster on its own natural (average) position, rather than cascading
  // every later label downward from the topmost one. A forward-only
  // cascade drifts badly on a short chart (mobile) when several labels
  // cluster near the top - it can push a label tens of pixels from its
  // actual line, past other, unrelated lines. Centering keeps each
  // cluster's drift local to where it actually is.
  function declutter(items, minGap, bounds) {
    const sorted = [...items].sort((a, b) => a.y - b.y);
    const clusters = [];
    for (const item of sorted) {
      const last = clusters[clusters.length - 1];
      if (last && item.y - last[last.length - 1].y < minGap) {
        last.push(item);
      } else {
        clusters.push([item]);
      }
    }

    const placed = [];
    for (const cluster of clusters) {
      const n = cluster.length;
      const avgY = cluster.reduce((sum, it) => sum + it.y, 0) / n;
      const totalSpan = (n - 1) * minGap;
      const start = avgY - totalSpan / 2;
      cluster.forEach((it, i) => placed.push({ ...it, trueY: it.y, y: start + i * minGap }));
    }

    // clustering can still leave two adjacent clusters' centered spans
    // touching or, for a large enough cluster, actually overlapping a
    // neighbor's position entirely - one more forward pass guarantees no
    // residual overlap. Critically, this must walk in TRUE price order
    // (trueY), not the just-centered y: a big cluster's centering math
    // can push its first item's y before a neighboring cluster's y (a
    // real, confirmed bug - verified a 12-item cluster centering could
    // place a lower-priced level 10px above a higher-priced one that sat
    // alone in its own cluster). Sorting by the already-corrupted y would
    // lock that inversion in; this pass can only fix spacing, not order,
    // so the order it walks in has to already be correct.
    placed.sort((a, b) => a.trueY - b.trueY);
    for (let i = 1; i < placed.length; i++) {
      const minY = placed[i - 1].y + minGap;
      if (placed[i].y < minY) placed[i].y = minY;
    }

    // At high density (order book walls + round-number bands + regular
    // levels can all cluster within a fraction of a percent of price) the
    // cascade above can push labels well outside the visible chart -
    // observed pushing a label to y=-248px and another to y=3846px in a
    // ~900px container, i.e. completely invisible. An off-screen label is
    // strictly worse than a slightly-tight one, so compress spacing (down
    // to a floor, never fully collapsed) and clamp the whole stack to stay
    // inside the container rather than letting it overflow.
    if (bounds && placed.length > 0) {
      const available = bounds.max - bounds.min;
      const span = placed[placed.length - 1].y - placed[0].y;
      if (span > available && placed.length > 1) {
        const tightGap = Math.max(available / (placed.length - 1), minGap * 0.4);
        const start = placed[0].y;
        placed.forEach((p, i) => {
          p.y = start + i * tightGap;
        });
      }
      const overflowBottom = placed[placed.length - 1].y - bounds.max;
      if (overflowBottom > 0) placed.forEach((p) => (p.y -= overflowBottom));
      const overflowTop = bounds.min - placed[0].y;
      if (overflowTop > 0) placed.forEach((p) => (p.y += overflowTop));
    }

    return placed;
  }

  // Checked against the marker's actual [low, high] range, not just its
  // midpoint - a marker whose line is only partly in view (a wide zone
  // whose center has scrolled off) still counts as visible, since there's
  // still a real line on screen to point a tag at.
  function markerIsVisible(marker, containerHeight) {
    const yHigh = candleSeries.priceToCoordinate(marker.high);
    const yLow = candleSeries.priceToCoordinate(marker.low);
    if (yHigh === null || yLow === null) return false;
    return yLow >= 0 && yHigh <= containerHeight;
  }

  const LIQUIDATION_BAR_WIDTH_PX = 16;
  const LIQUIDATION_MAX_OPACITY = 0.9;

  // Two thin heat-strip columns docked against the price axis (short/red
  // against the axis itself, long/green just inboard of it) - deliberately
  // NOT part of currentMarkers: there can be 100+ bins, and treating them
  // as clickable/decluttered "levels" the way real levels are would wreck
  // that system and the table/dropdown. Purely a background visual, same
  // as the always-on current-price line - unaffected by isolate.
  function renderLiquidationHeatmap(container) {
    for (const el of liquidationEls) el.remove();
    liquidationEls.length = 0;
    if (!activeLiquidationBins.length || !candleSeries) return;

    const containerHeight = container.clientHeight;

    // Bin intensities are normalized server-side against the single
    // hottest bin across the WHOLE +/-25% window - correct for comparing
    // bins to each other, but it means whatever's on screen right now can
    // look almost invisible if the all-time hottest spot happens to be
    // scrolled off elsewhere. Rescale again here against just what's
    // actually visible, so the chart always shows its own relative
    // hotspots at full strength instead of a global ranking that dims
    // everything whenever the single hottest zone isn't in view.
    const visible = [];
    for (const bin of activeLiquidationBins) {
      const yTop = candleSeries.priceToCoordinate(bin.price_high);
      const yBottom = candleSeries.priceToCoordinate(bin.price_low);
      if (yTop === null || yBottom === null) continue;
      if (yBottom < 0 || yTop > containerHeight) continue;
      visible.push({ bin, yTop, yBottom });
    }
    if (!visible.length) return;

    const visiblePeak =
      Math.max(...visible.flatMap((v) => [v.bin.long_intensity, v.bin.short_intensity])) || 1;

    const axisWidth = candleSeries.priceScale().width();
    const shortRight = axisWidth;
    const longRight = axisWidth + LIQUIDATION_BAR_WIDTH_PX;

    for (const { bin, yTop, yBottom } of visible) {
      const height = Math.max(1, yBottom - yTop);

      if (bin.short_intensity > 0) {
        const bar = document.createElement("div");
        bar.className = "liquidation-bar short";
        bar.style.top = `${yTop}px`;
        bar.style.height = `${height}px`;
        bar.style.right = `${shortRight}px`;
        bar.style.width = `${LIQUIDATION_BAR_WIDTH_PX}px`;
        bar.style.opacity = Math.min(1, bin.short_intensity / visiblePeak) * LIQUIDATION_MAX_OPACITY;
        bar.title = `Est. short liquidations near ${formatPriceRange(bin.price_low, bin.price_high)} (modeled, not real position data)`;
        container.appendChild(bar);
        liquidationEls.push(bar);
      }

      if (bin.long_intensity > 0) {
        const bar = document.createElement("div");
        bar.className = "liquidation-bar long";
        bar.style.top = `${yTop}px`;
        bar.style.height = `${height}px`;
        bar.style.right = `${longRight}px`;
        bar.style.width = `${LIQUIDATION_BAR_WIDTH_PX}px`;
        bar.style.opacity = Math.min(1, bin.long_intensity / visiblePeak) * LIQUIDATION_MAX_OPACITY;
        bar.title = `Est. long liquidations near ${formatPriceRange(bin.price_low, bin.price_high)} (modeled, not real position data)`;
        container.appendChild(bar);
        liquidationEls.push(bar);
      }
    }
  }

  function renderOverlays() {
    const container = document.getElementById("chart-container");
    for (const el of overlayEls) el.remove();
    overlayEls.length = 0;

    if (!candleSeries) return;
    lastOverlayPriceRange = candleSeries.priceScale().getVisibleRange();
    applyLineIsolation();
    renderLiquidationHeatmap(container);

    // zone shading draws at its exact price - only the text tags get
    // decluttered below.
    for (const marker of currentMarkers) {
      if (!marker.isZone) continue;
      if (snappedMarkerKey && marker.key !== snappedMarkerKey) continue; // isolated: only the selected marker's own zone shows
      const yTop = candleSeries.priceToCoordinate(marker.high);
      const yBottom = candleSeries.priceToCoordinate(marker.low);
      if (yTop === null || yBottom === null) continue;

      const band = document.createElement("div");
      band.className = "zone-overlay";
      band.style.top = `${yTop}px`;
      band.style.height = `${Math.max(1, yBottom - yTop)}px`;
      band.style.background = marker.color;
      band.style.opacity = marker.opacity !== undefined ? marker.opacity : "0.12";
      container.appendChild(band);
      overlayEls.push(band);
    }

    const containerHeight = container.clientHeight;

    // Several levels often cluster within a few % of each other, which
    // can be a tiny sliver of pixels once zoomed out (e.g. the Daily view
    // spanning a 2-year price range) - without this pass their text tags
    // would stack directly on top of each other. Filtering to just the
    // isolated marker here (rather than after) means decluttering has
    // nothing left to do - it'll just place the one remaining tag at its
    // own true position.
    //
    // Also filters out anything whose line isn't actually on screen right
    // now (checked against its real [low, high], not just its midpoint,
    // so a wide zone that only partly pokes into view still counts) - a
    // tag with no visible line to point at was confusable with a real
    // one, which is exactly what was reported. No arrow/off-screen
    // placeholder to replace it: if you can't see the line, you don't see
    // its tag either, full stop.
    const rawPositions = currentMarkers
      .filter((marker) => !snappedMarkerKey || marker.key === snappedMarkerKey)
      .filter((marker) => markerIsVisible(marker, containerHeight))
      .map((marker) => ({ marker, y: candleSeries.priceToCoordinate(marker.mid) }))
      .filter((p) => p.y !== null);
    const placements = declutter(rawPositions, LABEL_MIN_GAP_PX, { min: 4, max: containerHeight - 4 });

    for (const { marker, y, trueY } of placements) {
      // the bounding-box filter above guarantees marker.low/high intersect
      // the visible area, but trueY (the MIDPOINT's coordinate) can still
      // fall outside it for a wide zone whose center is off-screen while
      // an edge pokes into view - clamp just for where the tick/leader
      // point, same reasoning as before, minus the arrow (nothing fully
      // off-screen reaches this loop any more).
      const clampedTrueY = Math.max(0, Math.min(containerHeight, trueY));

      // dense clusters (common on a short/mobile chart) can still need to
      // push a label a visible distance from its real line - the leader
      // connects the two so it's never ambiguous which line a tag belongs
      // to, even when displaced. A horizontal tick right at the real
      // height does the actual pointing; the vertical bar just closes the
      // gap between that tick and wherever decluttering moved the label.
      if (Math.abs(y - clampedTrueY) > 1) {
        const leader = document.createElement("div");
        leader.className = "level-label-leader";
        leader.style.top = `${Math.min(y, clampedTrueY)}px`;
        leader.style.height = `${Math.abs(y - clampedTrueY)}px`;
        leader.style.background = marker.color;
        container.appendChild(leader);
        overlayEls.push(leader);
      }

      const tick = document.createElement("div");
      tick.className = "level-label-leader-tick";
      tick.style.top = `${clampedTrueY}px`;
      tick.style.background = marker.color;
      container.appendChild(tick);
      overlayEls.push(tick);

      const isSelected = marker.key === snappedMarkerKey;
      const tag = document.createElement("div");
      tag.className = `level-label${isSelected ? " level-label-selected" : ""}`;
      tag.style.top = `${y}px`;
      tag.style.background = marker.color;
      tag.textContent = marker.label;
      const clickHint = isSelected ? "click again to show everything" : "click to isolate this line";
      tag.title = `${marker.label} (${clickHint})`;
      // Every marker - a formal level, an order book wall, a round-number
      // proximity band - carries a `key` (set where it's pushed into
      // currentMarkers) and a real {low, high}, so the same toggle used by
      // the table and dropdown works here directly: click the tag itself,
      // it snaps the chart to it AND hides every other line/label (see
      // applyLineIsolation() and the isolation filters above); click
      // again, everything comes back. Works on any timeframe, since this
      // only ever touches the price axis, never the time axis. Clicking
      // the actual line on the chart (not just its tag) does the exact
      // same thing - see handleChartClick().
      tag.addEventListener("click", () => toggleMarkerSnap(marker.key, marker.low, marker.high));
      container.appendChild(tag);
      overlayEls.push(tag);
    }
  }

  function toTimePoint(candle, range) {
    // daily candles get a business-day-ish date string, intraday gets a unix time
    if (range === "1d") {
      const d = new Date(candle.time * 1000);
      return d.toISOString().slice(0, 10);
    }
    return candle.time;
  }

  // POC/VAH/VAL/range high-low are computed from the same levelsWindowDays
  // lookback - on 4H, open already framed to that same window so those
  // lines land on the actual high/low on screen, instead of fitContent()
  // showing ~120 days (the full fetch) and making a 60-day-scoped level
  // look like it's ignoring an older, bigger wick further left. Daily
  // view: full fetched history - there's no single lookback window that
  // cleanly maps to every Daily-relevant stat (golden pocket uses a
  // longer window than range high/low does), so that stays "zoom out for
  // context, labels already say their own scope" rather than forcing a
  // crop that still wouldn't match everything. Shared by renderChart and
  // resetPriceSnap (clicking a level row to snap away from this default,
  // then clicking it again to come back).
  function applyDefaultZoom(candleCount, range, levelsWindowDays) {
    if (range === "4h" && levelsWindowDays) {
      const candlesPerDay = 6; // 24h / 4h
      const windowBars = levelsWindowDays * candlesPerDay;
      const marginBars = Math.round(windowBars * 0.08);
      const from = Math.max(0, candleCount - windowBars - marginBars);
      const to = candleCount + 1;
      chart.timeScale().setVisibleLogicalRange({ from, to });
    } else {
      chart.timeScale().fitContent();
    }
  }

  function renderChart(candles, range, levelsWindowDays) {
    ensureChart();
    clearPriceSnapState(); // a fresh timeframe/asset load starts back at normal autoscale
    const candleData = candles.map((c) => ({
      time: toTimePoint(c, range),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
    const volumeData = candles.map((c) => ({
      time: toTimePoint(c, range),
      value: c.volume,
      color: c.close >= c.open ? cssVar("--support") : cssVar("--resistance"),
    }));
    candleSeries.setData(candleData);
    volumeSeries.setData(volumeData);

    activeLevelsWindowDays = levelsWindowDays;
    applyDefaultZoom(candleData.length, range, levelsWindowDays);

    // Seed the guard to the last rendered candle's true time rather than
    // nulling it out - nulling disabled the guard entirely for the very
    // next poll, which could then "update" an older candle from its own
    // last-2-rows batch before the current one, hitting the exact
    // older-than-last-bar error this guard exists to prevent.
    lastLiveUnixTime = candles.length ? candles[candles.length - 1].time : null;
  }

  // --- live price polling ---
  //
  // The daily snapshot (levels + the candles baked into site/data) only
  // updates once a day at 5 AM Central - that's deliberate, it's what
  // keeps the levels themselves fixed as a stable reference rather than a
  // moving target. But the chart itself can tick live: Kraken's public
  // OHLC endpoint sends CORS headers that allow browser-side requests
  // (verified against api.kraken.com directly), so we can poll it from
  // here with no server and no API key, same as the daily engine does.
  // Only the last 1-2 candles get updated in place - the historical
  // candles and every level line stay exactly as of the daily run.

  const LIVE_STALE_AFTER_MISSES = 2; // ~30s of failed polls before flagging the badge

  let consecutiveMisses = 0;

  function setLiveBadge(status) {
    // status: "live" | "reconnecting"
    const badge = document.getElementById("live-badge");
    badge.hidden = false;
    badge.classList.toggle("is-stale", status === "reconnecting");
    badge.querySelector(".live-label").textContent = status === "reconnecting" ? "Reconnecting" : "Live";
  }

  function noteLiveMiss() {
    consecutiveMisses += 1;
    if (consecutiveMisses >= LIVE_STALE_AFTER_MISSES) setLiveBadge("reconnecting");
  }

  async function pollLiveCandle() {
    const asset = state.asset;
    const range = state.range;
    const pair = ASSET_PAIRS[asset];
    const interval = RANGE_INTERVALS[range];

    try {
      const rows = await fetchKrakenCandles(pair, interval);
      if (!rows.length) return noteLiveMiss();

      // the toggle may have moved on to a different asset/range while this
      // request was in flight - if so, drop the result rather than draw it
      // onto the wrong series. Not a failure, so don't touch the miss count.
      if (state.asset !== asset || state.range !== range) return;

      // last 2 rows: the current forming candle, plus the previous one in
      // case it just closed between polls and we'd otherwise miss its
      // final close.
      const recent = rows.slice(-2);
      let lastClose = null;

      for (const candle of recent) {
        // series.update() throws if fed a time older than its current last
        // bar (e.g. a stale row left over from a reconnect, or any other
        // ordering surprise) - skip rather than risk it.
        if (lastLiveUnixTime !== null && candle.time < lastLiveUnixTime) continue;

        const point = { time: toTimePoint(candle, range) };

        candleSeries.update({
          ...point,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
        });
        volumeSeries.update({
          ...point,
          value: candle.volume,
          color: candle.close >= candle.open ? cssVar("--support") : cssVar("--resistance"),
        });
        lastLiveUnixTime = candle.time;
        lastClose = candle.close;
      }

      if (lastClose !== null) {
        document.getElementById("price-label").textContent = lastClose.toLocaleString(undefined, {
          maximumFractionDigits: 2,
        });
        renderNearestLevels(activeLevels, activeScorecard, lastClose);
        renderRoundProximityBands(lastClose, activeProximity);
        renderLevelJumpSelect(activeLevels, lastClose);
      }

      consecutiveMisses = 0;
      setLiveBadge("live");
    } catch (err) {
      console.error("live poll failed", err);
      noteLiveMiss();
    }

    // Best-effort, separate from the candle update above - a failed order
    // book fetch shouldn't mark the whole live poll as missed, it just
    // means the liquidity walls don't refresh this tick.
    try {
      const walls = await fetchOrderBookWalls(pair);
      if (state.asset === asset && state.range === range) renderOrderBookWalls(walls);
    } catch (err) {
      console.error("order book fetch failed", err);
    }
  }

  function startLivePolling() {
    pollLiveCandle();
    setInterval(pollLiveCandle, LIVE_POLL_MS);
  }

  // --- table ---

  function holdRateCellText(level, scorecard) {
    if (!scorecard) return "—";
    const parts = [];
    for (const kind of level.name.split(" + ")) {
      const s = scorecard[kind];
      if (!s || s.hold_rate_pct === null || s.hold_rate_pct === undefined) continue;
      const flag = s.low_confidence ? "*" : "";
      parts.push(`${s.hold_rate_pct.toFixed(0)}%${flag} (n=${s.resolved})`);
    }
    return parts.length ? parts.join(" / ") : "—";
  }

  // --- nearest-level cards ---

  function holdRateSummary(level, scorecard) {
    if (!scorecard) return "No historical data yet";
    const rates = [];
    let totalN = 0;
    let anyLowConfidence = false;
    for (const kind of level.name.split(" + ")) {
      const s = scorecard[kind];
      if (!s || s.hold_rate_pct === null || s.hold_rate_pct === undefined) continue;
      rates.push(s.hold_rate_pct);
      totalN += s.resolved;
      if (s.low_confidence) anyLowConfidence = true;
    }
    if (rates.length === 0) return "No historical data yet";

    const min = Math.min(...rates);
    const max = Math.max(...rates);
    const rateText = min === max ? `${min.toFixed(0)}%` : `${min.toFixed(0)}–${max.toFixed(0)}%`;
    const confidenceNote = anyLowConfidence ? ", low confidence" : "";
    return `Historically held ${rateText} of the time (n=${totalN}${confidenceNote})`;
  }

  function fillNearestCard(cardId, level, currentPrice, scorecard) {
    const card = document.getElementById(cardId);
    if (!level) {
      card.hidden = true;
      return;
    }
    card.hidden = false;

    const mid = (level.price_low + level.price_high) / 2;
    const distancePct = ((mid - currentPrice) / currentPrice) * 100;
    const priceText =
      level.price_high > level.price_low
        ? `${level.price_low.toLocaleString(undefined, { maximumFractionDigits: 2 })}–${level.price_high.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
        : level.price_low.toLocaleString(undefined, { maximumFractionDigits: 2 });

    card.querySelector(".nearest-card-name").textContent = `${level.name}${level.is_flip ? " 🔒" : ""}`;
    card.querySelector(".nearest-card-price").textContent = priceText;
    card.querySelector(".nearest-card-distance").textContent =
      `${distancePct >= 0 ? "+" : ""}${distancePct.toFixed(2)}%`;
    card.querySelector(".nearest-card-hold").textContent = holdRateSummary(level, scorecard);
  }

  // Round numbers are arithmetic, not data-derived - computed from the
  // live price directly rather than coming from the daily levels JSON.
  // Mirrors src/levels/round_numbers.py; keep both in sync if this
  // formula changes.
  function roundNumberStep(price) {
    const digits = Math.floor(Math.log10(price)) + 1;
    return Math.pow(10, digits - 2);
  }

  function nearestRoundNumbers(price) {
    const step = roundNumberStep(price);
    let below = Math.floor(price / step) * step;
    let above = Math.ceil(price / step) * step;
    if (below === price) below -= step;
    if (above === price) above += step;
    return { below, above };
  }

  function levelMid(level) {
    return (level.price_low + level.price_high) / 2;
  }

  // Recomputed off the live price, not the level's own type field - that
  // field reflects the price at the daily snapshot, which can be stale by
  // the time the live price has moved past a level. Shared by the nearest-
  // level cards and the level-jump dropdown's progress percentage, so both
  // always agree on which levels currently bracket price.
  function findNearestAboveBelow(levels, currentPrice) {
    let nearestAbove = null;
    let nearestBelow = null;
    for (const level of levels) {
      const mid = levelMid(level);
      if (mid > currentPrice && (nearestAbove === null || mid < levelMid(nearestAbove))) {
        nearestAbove = level;
      }
      if (mid < currentPrice && (nearestBelow === null || mid > levelMid(nearestBelow))) {
        nearestBelow = level;
      }
    }
    return { nearestAbove, nearestBelow };
  }

  function renderNearestLevels(levels, scorecard, currentPrice) {
    if (!levels || !levels.length || currentPrice === null || currentPrice === undefined) {
      document.getElementById("nearest-resistance-card").hidden = true;
      document.getElementById("nearest-support-card").hidden = true;
      document.getElementById("nearest-round-card").hidden = true;
      return;
    }

    const { nearestAbove, nearestBelow } = findNearestAboveBelow(levels, currentPrice);

    fillNearestCard("nearest-resistance-card", nearestAbove, currentPrice, scorecard);
    fillNearestCard("nearest-support-card", nearestBelow, currentPrice, scorecard);

    const { below: roundBelow, above: roundAbove } = nearestRoundNumbers(currentPrice);
    const nearestRoundPrice = currentPrice - roundBelow <= roundAbove - currentPrice ? roundBelow : roundAbove;
    fillNearestCard(
      "nearest-round-card",
      { name: "Round number", price_low: nearestRoundPrice, price_high: nearestRoundPrice, is_flip: false },
      currentPrice,
      scorecard
    );
  }

  // Backtest found that the hold rate isn't flat with distance - it drops
  // substantially the closer price actually gets to the round number (BTC
  // 55% -> 42% from a full step away down to 2%; ETH 69% -> 40%). Shown as
  // nested bands around the live nearest round number so that slope is
  // visible directly on the chart, not just as a table. Picked 3 of the 6
  // backtested tiers (loose/mid/tight) to keep it readable - all 6 would
  // just be 6 near-identical-looking rings.
  const ROUND_PROXIMITY_DISPLAY_TIERS = [
    { fraction: 0.5, opacity: 0.07 },
    { fraction: 0.1, opacity: 0.16 },
    { fraction: 0.02, opacity: 0.3 },
  ];

  function renderRoundProximityBands(currentPrice, proximityCurve) {
    currentMarkers = currentMarkers.filter((m) => !m.isRoundProximity);

    if (currentPrice !== null && currentPrice !== undefined && proximityCurve) {
      const step = roundNumberStep(currentPrice);
      const { below, above } = nearestRoundNumbers(currentPrice);
      const nearestRoundPrice = currentPrice - below <= above - currentPrice ? below : above;

      for (const { fraction, opacity } of ROUND_PROXIMITY_DISPLAY_TIERS) {
        const tier = proximityCurve.find((t) => t.tolerance_fraction === fraction);
        if (!tier || tier.hold_rate_pct === null) continue;
        const tolerance = step * fraction;
        currentMarkers.push({
          key: `proximity|${fraction}|${nearestRoundPrice}`,
          low: nearestRoundPrice - tolerance,
          high: nearestRoundPrice + tolerance,
          mid: nearestRoundPrice,
          color: cssVar("--round"),
          label: `Within ${Math.round(fraction * 100)}% of $${nearestRoundPrice.toLocaleString()} — ${tier.hold_rate_pct.toFixed(0)}% held (n=${tier.resolved})`,
          isZone: true,
          isRoundProximity: true,
          opacity,
        });
      }
    }

    renderOverlays();
  }

  function renderOrderBookWalls(walls) {
    for (const line of orderBookPriceLines) candleSeries.removePriceLine(line);
    orderBookPriceLines.length = 0;
    wallLinesByKey.clear();
    currentMarkers = currentMarkers.filter((m) => !m.isOrderBookWall);

    if (walls) {
      for (const wall of [...walls.bids, ...walls.asks]) {
        const wallKey = `wall|${wall.side}|${wall.price}`;
        const line = candleSeries.createPriceLine({
          price: wall.price,
          color: cssVar("--liquidity"),
          lineWidth: 1,
          lineStyle: LightweightCharts.LineStyle.SparseDotted,
          axisLabelVisible: true,
          title: "",
        });
        orderBookPriceLines.push(line);
        wallLinesByKey.set(wallKey, [line]);

        currentMarkers.push({
          key: wallKey,
          low: wall.price,
          high: wall.price,
          mid: wall.price,
          color: cssVar("--liquidity"),
          label: `${wall.side === "bid" ? "Bid" : "Ask"} wall: ${wall.volume.toFixed(2)} ${state.asset.toUpperCase()} @ ${formatPriceRange(wall.price, wall.price)}`,
          isZone: false,
          isOrderBookWall: true,
        });
      }
    }

    renderOverlays();
  }

  // --- trade journal ---
  //
  // Saved to this browser's localStorage only - no server, no account,
  // consistent with everything else in this project (the user explicitly
  // chose this over a synced backend). Won't follow you to a different
  // browser or device, and clearing site data wipes it. Trades are keyed
  // by a canonical unix timestamp, not whatever display format the active
  // timeframe happened to use at click time, so a trade marked on the
  // Daily view still renders correctly if you later look at it on 1h.

  function tradesStorageKey(asset) {
    return `daily-levels-trades-${asset}`;
  }

  function loadTrades(asset) {
    try {
      const raw = localStorage.getItem(tradesStorageKey(asset));
      return raw ? JSON.parse(raw) : [];
    } catch (err) {
      console.error("could not read saved trades", err);
      return [];
    }
  }

  function saveTrades(asset, trades) {
    try {
      localStorage.setItem(tradesStorageKey(asset), JSON.stringify(trades));
    } catch (err) {
      console.error("could not save trade", err);
      alert("Couldn't save that trade - your browser's local storage may be full or blocked (private browsing can do this).");
    }
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // The inverse of toTimePoint(): a chart click's `time` comes back as a
  // raw unix number for intraday ranges, or a date string / {year,month,day}
  // business-day object for the Daily range - normalize whichever shape
  // shows up into one canonical unix-seconds integer for storage.
  function resolveClickTimeToUnix(time, range) {
    if (range !== "1d") {
      return typeof time === "number" ? time : null;
    }
    if (typeof time === "string") {
      return Math.floor(new Date(`${time}T00:00:00Z`).getTime() / 1000);
    }
    if (time && typeof time === "object" && "year" in time) {
      return Math.floor(Date.UTC(time.year, time.month - 1, time.day) / 1000);
    }
    return null;
  }

  function setMarkingMode(on) {
    markingMode = on;
    const btn = document.getElementById("mark-trade-btn");
    const hint = document.getElementById("mark-trade-hint");
    btn.classList.toggle("active", on);
    btn.textContent = on ? "Cancel marking" : "+ Mark trade";
    hint.hidden = !on;
  }

  function openTradeForm() {
    if (!pendingTrade) return;
    const saveBtn = document.getElementById("trade-form-save");
    document.getElementById("trade-form-price").textContent = `Entry: ${formatPriceRange(pendingTrade.price, pendingTrade.price)}`;
    document.getElementById("trade-form-description").value = "";
    document.querySelectorAll(".trade-dir-btn").forEach((b) => b.classList.remove("active"));
    saveBtn.disabled = true;
    saveBtn.dataset.direction = "";
    document.getElementById("trade-form").hidden = false;
  }

  function closeTradeForm() {
    document.getElementById("trade-form").hidden = true;
    pendingTrade = null;
  }

  // Finds whichever currently-drawn line a click/hover at this y landed
  // close enough to, in price terms (so the hit area stays the same
  // number of pixels regardless of zoom level, rather than a fixed price
  // window that's huge when zoomed out and tiny when zoomed in). A zone
  // marker (low !== high) counts as a hit anywhere inside its range, not
  // just right on one boundary line - distance is 0 there, same as
  // clicking exactly on a single-price marker's own line.
  function findMarkerNearPoint(y) {
    if (!candleSeries) return null;
    const priceAtY = candleSeries.coordinateToPrice(y);
    const priceAtTolerance = candleSeries.coordinateToPrice(y + LINE_CLICK_TOLERANCE_PX);
    if (priceAtY === null || priceAtTolerance === null) return null;
    const priceTolerance = Math.abs(priceAtTolerance - priceAtY);

    let best = null;
    let bestDist = Infinity;
    for (const marker of currentMarkers) {
      // isolated: every other line is actually hidden (applyLineIsolation),
      // so only the one still drawn can be "clicked" at all.
      if (snappedMarkerKey && marker.key !== snappedMarkerKey) continue;
      const dist = priceAtY < marker.low ? marker.low - priceAtY : priceAtY > marker.high ? priceAtY - marker.high : 0;
      if (dist <= priceTolerance && dist < bestDist) {
        best = marker;
        bestDist = dist;
      }
    }
    return best;
  }

  function handleChartClick(param) {
    if (markingMode) {
      if (!param.point || param.time === undefined) return;
      const price = candleSeries.coordinateToPrice(param.point.y);
      const unixTime = resolveClickTimeToUnix(param.time, state.range);
      if (price === null || unixTime === null) return;

      pendingTrade = { time: unixTime, price };
      setMarkingMode(false);
      openTradeForm();
      return;
    }

    // Not marking a trade: clicking anywhere on an actual drawn line -
    // not just its tag, which decluttering can push well away from the
    // line itself - isolates it. Same toggle the table, dropdown, and
    // tag clicks already use, so it stays in sync with all three.
    if (!param.point) return;
    const marker = findMarkerNearPoint(param.point.y);
    if (marker) toggleMarkerSnap(marker.key, marker.low, marker.high);
  }

  function renderTradeMarkers(asset, range, candles) {
    if (!tradeMarkersPlugin) return;
    const trades = loadTrades(asset);
    if (!trades.length || !candles.length) {
      tradeMarkersPlugin.setMarkers([]);
      return;
    }

    // a trade marked on a wide-history timeframe won't necessarily fall
    // within a narrower timeframe's currently-loaded candles (e.g. a
    // trade from 3 days ago isn't in the 1m view's ~12h window) - skip
    // rather than hand the library a time it has no bar for.
    const minTime = candles[0].time;
    const maxTime = candles[candles.length - 1].time;

    const markers = trades
      .filter((t) => t.time >= minTime && t.time <= maxTime)
      .map((t) => ({
        time: toTimePoint({ time: t.time }, range),
        position: t.direction === "long" ? "belowBar" : "aboveBar",
        color: t.direction === "long" ? cssVar("--support") : cssVar("--resistance"),
        shape: t.direction === "long" ? "arrowUp" : "arrowDown",
        text: t.direction === "long" ? "Long" : "Short",
      }))
      .sort((a, b) => (a.time > b.time ? 1 : a.time < b.time ? -1 : 0));

    tradeMarkersPlugin.setMarkers(markers);
  }

  function deleteTrade(asset, id) {
    saveTrades(asset, loadTrades(asset).filter((t) => t.id !== id));
    renderTradeMarkers(state.asset, state.range, activeCandles);
    renderTradesTable(asset);
  }

  function renderTradesTable(asset) {
    const tbody = document.getElementById("trades-table-body");
    tbody.innerHTML = "";

    const trades = [...loadTrades(asset)].sort((a, b) => b.time - a.time);
    if (!trades.length) {
      tbody.innerHTML = `<tr><td colspan="5">No trades marked yet for ${asset.toUpperCase()}.</td></tr>`;
      return;
    }

    for (const trade of trades) {
      const tr = document.createElement("tr");
      const dateText = new Date(trade.time * 1000).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
      const directionColor = trade.direction === "long" ? "var(--support)" : "var(--resistance)";
      tr.innerHTML = `
        <td>${dateText}</td>
        <td class="type-cell" style="color: ${directionColor}">${trade.direction}</td>
        <td>${formatPriceRange(trade.price, trade.price)}</td>
        <td class="trade-note-cell">${trade.description ? escapeHtml(trade.description) : "—"}</td>
        <td></td>
      `;
      const deleteBtn = document.createElement("button");
      deleteBtn.className = "trade-delete-btn";
      deleteBtn.textContent = "Delete";
      deleteBtn.addEventListener("click", () => deleteTrade(asset, trade.id));
      tr.lastElementChild.appendChild(deleteBtn);
      tbody.appendChild(tr);
    }
  }

  function useManualTradePrice() {
    const input = document.getElementById("trade-manual-price");
    const price = parseFloat(input.value);
    if (!Number.isFinite(price) || price <= 0) return;

    setMarkingMode(false);
    // typed entries aren't tied to a chart bar - stamp them "now" so they
    // sort and plot (once a candle at this time exists) like any other trade.
    pendingTrade = { time: Math.floor(Date.now() / 1000), price };
    input.value = "";
    openTradeForm();
  }

  function wireTradeForm() {
    document.getElementById("mark-trade-btn").addEventListener("click", () => {
      if (markingMode) {
        setMarkingMode(false);
      } else {
        closeTradeForm();
        setMarkingMode(true);
      }
    });

    document.getElementById("trade-manual-btn").addEventListener("click", useManualTradePrice);
    document.getElementById("trade-manual-price").addEventListener("keydown", (e) => {
      if (e.key === "Enter") useManualTradePrice();
    });

    document.querySelectorAll(".trade-dir-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".trade-dir-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const saveBtn = document.getElementById("trade-form-save");
        saveBtn.dataset.direction = btn.dataset.direction;
        saveBtn.disabled = false;
      });
    });

    document.getElementById("trade-form-cancel").addEventListener("click", closeTradeForm);

    document.getElementById("trade-form-save").addEventListener("click", (e) => {
      const direction = e.currentTarget.dataset.direction;
      if (!pendingTrade || !direction) return;

      const trades = loadTrades(state.asset);
      trades.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        time: pendingTrade.time,
        price: pendingTrade.price,
        direction,
        description: document.getElementById("trade-form-description").value.trim(),
        createdAt: new Date().toISOString(),
      });
      saveTrades(state.asset, trades);

      closeTradeForm();
      renderTradeMarkers(state.asset, state.range, activeCandles);
      renderTradesTable(state.asset);
    });
  }

  function diffByKindMap(diff) {
    const map = {};
    if (!diff) return map;
    for (const entry of diff) map[entry.kind] = entry;
    return map;
  }

  function diffBadgeHtml(level, diffMap) {
    let best = null; // priority: a "new" constituent wins over a "moved" one
    for (const kind of level.name.split(" + ")) {
      const entry = diffMap[kind];
      if (!entry) continue;
      if (entry.status === "new") {
        best = entry;
        break;
      }
      if (entry.status === "moved" && !best) best = entry;
    }
    if (!best) return "";
    if (best.status === "new") return `<span class="diff-badge diff-new">NEW</span>`;
    const arrow = best.change_pct >= 0 ? "▲" : "▼";
    return `<span class="diff-badge diff-moved">${arrow} ${Math.abs(best.change_pct).toFixed(2)}%</span>`;
  }

  function renderRemovedNote(diff) {
    const el = document.getElementById("removed-levels-note");
    const removed = (diff || []).filter((d) => d.status === "removed");
    if (removed.length === 0) {
      el.hidden = true;
      return;
    }
    const text = removed
      .map((d) => `${d.kind} (was ${d.old_price.toLocaleString(undefined, { maximumFractionDigits: 2 })})`)
      .join(", ");
    el.textContent = `No longer a level since yesterday: ${text}`;
    el.hidden = false;
  }

  // --- click a level row, snap the chart's price axis to show it ---
  //
  // Levels can sit far outside whatever price range the candles happen to
  // autoscale to right now (e.g. "Range low" from 60 days ago while
  // price has since run up) - the line is still drawn, but you'd have to
  // manually scroll/zoom the price axis to ever see it. This makes every
  // row in the level table a one-click way to bring its line into view.

  function levelKey(level) {
    return `${level.name}|${level.price_low}|${level.price_high}`;
  }

  // Generic "frame this price band" - used for a formal level (from the
  // table or dropdown) and for any other chart marker (an order book
  // wall, a round-number proximity band) alike, since all of them boil
  // down to the same {low, high} pair once you're past where the number
  // came from.
  function snapToRange(low, high) {
    if (!candleSeries) return;
    const mid = (low + high) / 2;
    const margin = Math.max(high - low, mid * 0.03);
    const priceScale = candleSeries.priceScale();
    priceScale.setAutoScale(false);
    priceScale.setVisibleRange({ from: low - margin, to: high + margin });
    // every other label's position was computed against the price scale
    // from before this jump - the time-axis subscription that normally
    // keeps them current doesn't fire for a price-only change (the
    // library has no equivalent event for the price scale), so without
    // this they'd sit wherever they were before, pointing at nothing.
    renderOverlays();
  }

  function clearPriceSnapState() {
    snappedMarkerKey = null;
    if (candleSeries) candleSeries.priceScale().setAutoScale(true);
  }

  // The user-facing "un-snap". setAutoScale(true) alone only changes
  // behavior going forward - it does NOT retroactively recompute the
  // range that's already visible (verified directly: the chart stayed
  // zoomed into the clicked level after toggling off, until some other
  // action happened to nudge it). So: restore the known default TIME
  // window first, so "un-snap" always lands back on the same framing
  // regardless of whether the user panned around while a level was
  // snapped, then measure that window's candles and set the price range
  // to fit them directly. Future manual pans/zooms still autoscale
  // normally from here.
  function resetPriceSnap() {
    clearPriceSnapState();
    if (!activeCandles.length || !candleSeries) return;

    applyDefaultZoom(activeCandles.length, state.range, activeLevelsWindowDays);

    let candlesInView = activeCandles;
    const visibleRange = chart.timeScale().getVisibleLogicalRange();
    if (visibleRange) {
      const startIdx = Math.max(0, Math.floor(visibleRange.from));
      const endIdx = Math.min(activeCandles.length - 1, Math.ceil(visibleRange.to));
      if (endIdx >= startIdx) candlesInView = activeCandles.slice(startIdx, endIdx + 1);
    }
    if (!candlesInView.length) candlesInView = activeCandles;

    const high = Math.max(...candlesInView.map((c) => c.high));
    const low = Math.min(...candlesInView.map((c) => c.low));
    // getVisibleRange()/setVisibleRange() deal in bare data values - the
    // configured scaleMargins only pad the rendering, they're never baked
    // into the from/to numbers - so the exact high/low IS what autoscale
    // itself would have landed on (confirmed directly: an autoscaled
    // getVisibleRange() matched a view's raw candle high/low exactly, with
    // zero padding, on the actual chart).
    candleSeries.priceScale().setVisibleRange({ from: low, to: high });
    renderOverlays(); // same staleness reason as the one in snapToRange()
  }

  // Toggling a marker's snap state from the table, the dropdown, or
  // directly clicking its tag on the chart needs to leave all three in
  // sync, so this is the one place that actually changes
  // `snappedMarkerKey` - everything else just calls this with whatever
  // {key, low, high} it has on hand.
  function toggleMarkerSnap(key, low, high) {
    if (snappedMarkerKey === key) {
      resetPriceSnap();
    } else {
      snappedMarkerKey = key;
      snapToRange(low, high);
    }
    syncLevelSelectionUi();
  }

  function toggleLevelSnap(level) {
    toggleMarkerSnap(levelKey(level), level.price_low, level.price_high);
  }

  function syncLevelSelectionUi() {
    document.querySelectorAll("#levels-table-body tr").forEach((row) => {
      row.classList.toggle("level-row-selected", row.dataset.levelKey === snappedMarkerKey);
    });
    const select = document.getElementById("level-jump-select");
    if (select) select.value = snappedMarkerKey || "";
  }

  // "Progress across the gap to it" - 0% means price is sitting at the
  // nearest level on the OPPOSITE side (the one it would have to cross
  // back through first), 100% means price has arrived at this level.
  // Generalizes the round-number proximity curve's "closer = higher
  // percentage" idea to every level, anchored on the two real levels
  // price is currently between rather than an arbitrary cutoff. No
  // opposite-side anchor exists when price is beyond every known level in
  // that direction (e.g. below the 60-day range low) - returns null there
  // rather than inventing a reference point.
  function levelProgressPct(level, currentPrice, nearestAbove, nearestBelow) {
    const mid = levelMid(level);
    if (currentPrice >= level.price_low && currentPrice <= level.price_high) return 100;

    if (mid > currentPrice) {
      if (!nearestBelow) return null;
      const anchor = levelMid(nearestBelow);
      return clamp(((currentPrice - anchor) / (mid - anchor)) * 100, 0, 100);
    }
    if (!nearestAbove) return null;
    const anchor = levelMid(nearestAbove);
    return clamp(((anchor - currentPrice) / (anchor - mid)) * 100, 0, 100);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function renderLevelJumpSelect(levels, currentPrice) {
    const select = document.getElementById("level-jump-select");
    if (!select) return;
    if (!levels || !levels.length || currentPrice === null || currentPrice === undefined) {
      select.innerHTML = `<option value="">Default view</option>`;
      select.disabled = true;
      return;
    }
    select.disabled = false;

    const { nearestAbove, nearestBelow } = findNearestAboveBelow(levels, currentPrice);
    const sorted = [...levels].sort(
      (a, b) => Math.abs(levelMid(a) - currentPrice) - Math.abs(levelMid(b) - currentPrice)
    );

    const options = [`<option value="">Default view</option>`];
    for (const level of sorted) {
      const key = levelKey(level);
      const priceText = level.price_high > level.price_low
        ? formatPriceRange(level.price_low, level.price_high)
        : level.price_low.toLocaleString(undefined, { maximumFractionDigits: 2 });
      const distancePct = ((levelMid(level) - currentPrice) / currentPrice) * 100;
      const pct = levelProgressPct(level, currentPrice, nearestAbove, nearestBelow);
      const pctText = pct === null ? "" : `, ${pct.toFixed(0)}% there`;
      const label = `${level.name} — ${priceText} (${distancePct >= 0 ? "+" : ""}${distancePct.toFixed(2)}%${pctText})`;
      options.push(`<option value="${escapeHtml(key)}">${escapeHtml(label)}</option>`);
    }
    select.innerHTML = options.join("");
    select.value = snappedMarkerKey || "";
  }

  function wireLevelJumpSelect() {
    const select = document.getElementById("level-jump-select");
    if (!select) return;
    select.addEventListener("change", () => {
      const key = select.value;
      if (!key) {
        resetPriceSnap();
        syncLevelSelectionUi();
        return;
      }
      const level = activeLevels.find((l) => levelKey(l) === key);
      if (!level) return;
      snappedMarkerKey = key;
      snapToRange(level.price_low, level.price_high);
      syncLevelSelectionUi();
    });
  }

  function renderTable(levels, currentPrice, scorecard, diff) {
    const diffMap = diffByKindMap(diff);
    renderRemovedNote(diff);

    const tbody = document.getElementById("levels-table-body");
    tbody.innerHTML = "";

    const sorted = [...levels].sort(
      (a, b) => (a.price_low + a.price_high) / 2 - (b.price_low + b.price_high) / 2
    );

    let insertedCurrentRow = false;
    for (const level of sorted) {
      const mid = (level.price_low + level.price_high) / 2;

      if (!insertedCurrentRow && mid > currentPrice) {
        tbody.appendChild(currentPriceRow(currentPrice));
        insertedCurrentRow = true;
      }

      const tr = document.createElement("tr");
      const key = levelKey(level);
      tr.className = `type-${level.type}${level.is_flip ? " is-flip" : ""} level-row-clickable${key === snappedMarkerKey ? " level-row-selected" : ""}`;
      tr.title = "Click to isolate this level on the chart (click again to show everything)";
      tr.dataset.levelKey = key;

      const priceText =
        level.price_high > level.price_low
          ? `${level.price_low.toLocaleString(undefined, { maximumFractionDigits: 2 })}–${level.price_high.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
          : level.price_low.toLocaleString(undefined, { maximumFractionDigits: 2 });

      tr.innerHTML = `
        <td>${level.name}${level.is_flip ? " 🔒" : ""} ${diffBadgeHtml(level, diffMap)}</td>
        <td>${priceText}</td>
        <td>${level.distance_pct >= 0 ? "+" : ""}${level.distance_pct.toFixed(2)}%</td>
        <td class="type-cell">${level.is_flip ? "flip" : level.type}</td>
        <td>${level.strength}</td>
        <td class="hold-rate-cell">${holdRateCellText(level, scorecard)}</td>
      `;
      tr.addEventListener("click", () => toggleLevelSnap(level));
      tbody.appendChild(tr);
    }

    if (!insertedCurrentRow) {
      tbody.appendChild(currentPriceRow(currentPrice));
    }
  }

  function currentPriceRow(currentPrice) {
    const tr = document.createElement("tr");
    tr.className = "current-price-row";
    tr.innerHTML = `
      <td colspan="2">— current price —</td>
      <td>${currentPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
      <td></td>
      <td></td>
      <td></td>
    `;
    return tr;
  }

  // --- header / staleness ---

  function renderHeader(levelsData) {
    const generated = new Date(levelsData.generated_at_utc);
    const formatted = new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "America/Chicago",
    }).format(generated);

    document.getElementById("generated-label").textContent = `Levels calculated ${formatted} CT`;
    document.getElementById("price-label").textContent = levelsData.price.toLocaleString(undefined, {
      maximumFractionDigits: 2,
    });

    const hoursOld = (Date.now() - generated.getTime()) / 3_600_000;
    const banner = document.getElementById("stale-banner");
    if (hoursOld > STALE_HOURS) {
      banner.hidden = false;
      banner.textContent = `Data is ${hoursOld.toFixed(0)} hours old and may be stale — the daily run may have failed.`;
    } else {
      banner.hidden = true;
    }
  }

  // Kraken Futures' open-interest/funding endpoint has no CORS header at
  // all (checked the raw response headers directly) - can't be polled
  // live from the browser like everything else, so this comes from the
  // once-a-day snapshot instead (fetched server-side in the daily Action).
  // Kraken Futures pays funding hourly, not every 8h like most exchanges -
  // labeled explicitly so it isn't misread against an 8h-funding mental
  // model from other exchanges.
  function renderFuturesContext(context) {
    const el = document.getElementById("futures-context");
    if (!context) {
      el.hidden = true;
      return;
    }
    el.hidden = false;

    const fundingPct = context.funding_rate_hourly_pct;
    const fundingText =
      fundingPct === null || fundingPct === undefined
        ? "—"
        : `${fundingPct >= 0 ? "+" : ""}${fundingPct.toFixed(4)}%/hr`;

    const oiAsset = context.open_interest;
    const oiUsd = oiAsset !== null && oiAsset !== undefined && context.mark_price ? oiAsset * context.mark_price : null;
    const oiText =
      oiAsset === null || oiAsset === undefined
        ? "—"
        : `${oiAsset.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${state.asset.toUpperCase()}${
            oiUsd ? ` (~$${(oiUsd / 1_000_000).toFixed(1)}M)` : ""
          }`;

    el.innerHTML = `
      <span>Perp funding: <strong>${fundingText}</strong></span>
      <span>Open interest: <strong>${oiText}</strong></span>
    `;
  }

  // --- scorecard table ---

  function renderScorecardTable(scorecard) {
    const tbody = document.getElementById("scorecard-table-body");
    tbody.innerHTML = "";

    if (!scorecard || Object.keys(scorecard).length === 0) {
      tbody.innerHTML = `<tr><td colspan="6">Scorecard not available yet.</td></tr>`;
      return;
    }

    const pct = (v) => (v === null || v === undefined ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`);

    const rows = Object.entries(scorecard).sort((a, b) => b[1].resolved - a[1].resolved);
    for (const [kind, s] of rows) {
      const tr = document.createElement("tr");
      if (s.low_confidence) tr.className = "low-confidence-row";
      tr.innerHTML = `
        <td>${kind}${s.low_confidence ? " *" : ""}</td>
        <td>${s.touches}</td>
        <td>${s.resolved}</td>
        <td>${s.hold_rate_pct === null ? "—" : `${s.hold_rate_pct.toFixed(1)}%`}</td>
        <td>${pct(s.avg_move_after_hold_pct)}</td>
        <td>${pct(s.avg_move_after_break_pct)}</td>
      `;
      tbody.appendChild(tr);
    }
  }

  // --- toggles ---

  function setActiveButtons() {
    document.querySelectorAll("#asset-toggle .toggle-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.asset === state.asset);
    });
    document.getElementById("range-select").value = state.range;
  }

  function wireToggles() {
    document.querySelectorAll("#asset-toggle .toggle-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.asset = btn.dataset.asset;
        setActiveButtons();
        writeHash();
        // a pending trade's price/time belong to whatever asset was
        // active when the chart was clicked - switching assets mid-entry
        // would otherwise save it against the wrong one.
        setMarkingMode(false);
        closeTradeForm();
        loadAndRender().then(pollLiveCandle);
      });
    });
    document.getElementById("range-select").addEventListener("change", (e) => {
      state.range = e.target.value;
      setActiveButtons();
      writeHash();
      setMarkingMode(false);
      closeTradeForm();
      loadAndRender().then(pollLiveCandle);
    });

    const refreshBtn = document.getElementById("refresh-btn");
    refreshBtn.addEventListener("click", async () => {
      // Re-fetches levels/scorecard/candles without a full page reload -
      // useful if the daily job just ran and you don't want to wait for
      // the next scheduled poll or a manual F5. This only re-fetches
      // whatever's currently committed; it can't trigger a new
      // computation - the site is static, there's no server to ask.
      refreshBtn.disabled = true;
      refreshBtn.textContent = "⟳ Refreshing…";
      try {
        await loadAndRender();
      } finally {
        refreshBtn.disabled = false;
        refreshBtn.textContent = "⟳ Refresh";
      }
    });
  }

  // --- main load ---

  async function loadAndRender() {
    const asset = state.asset;
    const range = state.range;
    try {
      const [levelsData, candles] = await Promise.all([
        fetchJson(levelsUrl(asset)),
        fetchKrakenCandles(ASSET_PAIRS[asset], RANGE_INTERVALS[range]),
      ]);

      // if the user switched asset/range again while this was in flight,
      // a newer loadAndRender() call either already finished or is about
      // to - drawing this now-stale result would stomp it.
      if (state.asset !== asset || state.range !== range) return;

      renderHeader(levelsData);
      renderFuturesContext(levelsData.futures_context);
      // set before renderChart(): its zoom call can trigger the time-axis
      // subscription straight into renderOverlays() (which draws the
      // heatmap), and that would otherwise run once against the previous
      // asset's bins before renderLevels() below gets a chance to update it.
      activeLiquidationBins = levelsData.liquidation_estimate || [];
      renderChart(candles, range, levelsData.config.range_days);
      renderLevels(levelsData.levels);

      activeCandles = candles;
      renderTradeMarkers(asset, range, candles);
      renderTradesTable(asset);

      // The scorecard and proximity curve are nice-to-haves, not core - if
      // either is missing (first rollout before a backtest has run, or a
      // fetch hiccup) the levels table and chart should still render
      // fine, just without hold rates / proximity bands.
      let scorecard = null;
      try {
        scorecard = await fetchJson(scorecardUrl(asset));
      } catch (err) {
        console.error("scorecard unavailable", err);
      }
      let proximity = null;
      try {
        proximity = await fetchJson(proximityUrl(asset));
      } catch (err) {
        console.error("round-number proximity curve unavailable", err);
      }
      if (state.asset !== asset || state.range !== range) return;

      renderTable(levelsData.levels, levelsData.price, scorecard, levelsData.diff);
      renderScorecardTable(scorecard);

      activeLevels = levelsData.levels;
      activeScorecard = scorecard;
      activeProximity = proximity;
      renderNearestLevels(activeLevels, activeScorecard, levelsData.price);
      renderRoundProximityBands(levelsData.price, activeProximity);
      renderLevelJumpSelect(activeLevels, levelsData.price);
    } catch (err) {
      if (state.asset !== asset || state.range !== range) return;
      console.error(err);
      const banner = document.getElementById("stale-banner");
      banner.hidden = false;
      banner.textContent = "Could not load level or price data — either the daily workflow hasn't run yet, or Kraken's API is unreachable right now.";
    }
  }

  readHash();
  setActiveButtons();
  wireToggles();
  wireTradeForm();
  wireLevelJumpSelect();
  loadAndRender().then(startLivePolling);
})();
