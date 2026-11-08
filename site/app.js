(function () {
  "use strict";

  const STALE_HOURS = 26;
  const FALLBACK_POLL_MS = 10000;
  const ORDER_BOOK_POLL_MS = 10000;
  const LIVE_RECONNECT_MAX_MS = 30000;
  const LIVE_STREAM_STALE_MS = 15000;
  const DERIVED_RENDER_THROTTLE_MS = 400;
  const KRAKEN_OHLC_URL = "https://api.kraken.com/0/public/OHLC";
  const KRAKEN_DEPTH_URL = "https://api.kraken.com/0/public/Depth";
  const ASSET_PAIRS = { btc: "BTC/USD", eth: "ETH/USD" };
  // Kraken's public OHLC endpoint always returns just the most recent 720
  // candles no matter what `since` is set to (confirmed directly: since=1
  // and since=a 2020 date both came back anchored to "now", never further
  // back) - there is no way to page past that on this endpoint, from the
  // browser or a server. For Daily specifically, Coinbase's public candles
  // endpoint (also CORS-friendly, no key) has real daily data back to
  // 2015/2016 and supports genuine start/end pagination, so the "Daily"
  // view's history comes from there instead, with Kraken's own fetch still
  // covering the live/most-recent end exactly as before.
  const COINBASE_CANDLES_URL = "https://api.exchange.coinbase.com/products";
  const COINBASE_PRODUCT_IDS = { btc: "BTC-USD", eth: "ETH-USD" };
  const COINBASE_HISTORY_START = "2015-01-01T00:00:00Z"; // before this, both products just return empty - handled gracefully, not an error
  const COINBASE_MAX_DAYS_PER_CALL = 300; // Coinbase rejects a request spanning more than this many daily candles
  // the candle price scale reserves extra room at the bottom for the volume
  // series beneath it, so "fit these candles" must reproduce this same
  // asymmetric split - a flat symmetric margin visibly doesn't match what
  // autoscale actually renders.
  const CANDLE_SCALE_MARGINS = { top: 0.08, bottom: 0.3 };
  const RANGE_INTERVALS = { "1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240, "1d": 1440 };
  const PATIENCE_ALERT_PREF_KEY = "range-desk:patience-alerts:v1";
  const PATIENCE_ALERTED_KEY = "range-desk:patience-alerted:v1";
  const PAPER_EVENT_STATE_KEY = "range-desk:paper-event-state:v1";
  const RANGE_LAB_POLL_MS = 300000;

  const state = {
    asset: "btc",
    range: "4h",
    spyTimeframe: "15",
  };

  let patienceAlertsEnabled = false;
  let patienceAlertMemory = [];
  let patienceToastTimer = null;

  function readHash() {
    const params = new URLSearchParams(location.hash.replace(/^#/, ""));
    const asset = params.get("asset");
    if (asset === "eth" || asset === "spy") state.asset = asset;
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

  function readLocalStorage(key, fallback = null) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : value;
    } catch (_) {
      return fallback;
    }
  }

  function writeLocalStorage(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (_) {
      return false;
    }
  }

  // Switching asset/timeframe previously left the OLD chart sitting there
  // with zero visual feedback until the new fetch resolved - looked frozen
  // on a slow connection or Kraken's own occasional CORS hiccup (see the
  // gotcha in CLAUDE.md). This dims the chart and shows "Loading…" for the
  // duration of any loadAndRender()/loadAndRenderSpy() call.
  function setChartLoading(isLoading) {
    const el = document.getElementById("chart-loading-overlay");
    if (el) el.hidden = !isLoading;
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

  function rangeLabUrl() {
    return "data/btc_range_lab.json";
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

  // One page of Coinbase's public daily candles (CORS-friendly, no key -
  // confirmed directly against api.exchange.coinbase.com). Coinbase's own
  // row shape is [time, low, high, open, close, volume] - a different
  // column order than Kraken's, mapped here rather than at the call site
  // so every caller deals in the same {time, open, high, low, close,
  // volume} shape as fetchKrakenCandles.
  async function fetchCoinbaseDailyPage(productId, startIso, endIso) {
    const url = `${COINBASE_CANDLES_URL}/${productId}/candles?granularity=86400&start=${startIso}&end=${endIso}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`Coinbase candles fetch failed: ${res.status}`);
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error(`Coinbase error: ${rows.message || "unexpected response"}`);
    return rows.map((row) => ({
      time: row[0],
      low: row[1],
      high: row[2],
      open: row[3],
      close: row[4],
      volume: row[5],
    }));
  }

  // Deep daily history for the "Daily" view specifically - Kraken's own
  // fetch only ever covers its most recent ~720 days (see the constant
  // comments above), so this fills in everything older than that from
  // Coinbase instead, paginated in <=300-day windows from
  // COINBASE_HISTORY_START up to today. Best-effort: any single page
  // failing just logs and returns whatever pages DID succeed, rather than
  // losing the whole chart's deep history over one flaky request - this
  // is a bonus on top of the always-reliable Kraken fetch, not something
  // the page depends on to render at all.
  async function fetchCoinbaseDailyHistory(productId) {
    const start = new Date(COINBASE_HISTORY_START);
    const now = new Date();
    const windows = [];
    let windowStart = start;
    while (windowStart < now) {
      const windowEnd = new Date(Math.min(windowStart.getTime() + COINBASE_MAX_DAYS_PER_CALL * 86400 * 1000, now.getTime()));
      windows.push([windowStart.toISOString(), windowEnd.toISOString()]);
      windowStart = windowEnd;
    }

    const pages = await Promise.all(
      windows.map(([startIso, endIso]) =>
        fetchCoinbaseDailyPage(productId, startIso, endIso).catch((err) => {
          console.error("Coinbase deep-history page failed", startIso, endIso, err);
          return [];
        })
      )
    );

    const byTime = new Map();
    for (const row of pages.flat()) byTime.set(row.time, row);
    return [...byTime.values()].sort((a, b) => a.time - b.time);
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
  const orderBookPriceLines = []; // separate from activePriceLines - these redraw on their own 10s order-book refresh, not every trade tick
  const tradeRiskPriceLines = [];
  let tradeRiskLineSignature = "";
  const overlayEls = [];
  let currentMarkers = []; // {key, low, high, mid, color, label, isZone} for repositioning on redraw
  // native IPriceLine objects, keyed by the same marker key, so "isolate"
  // can toggle lineVisible/axisLabelVisible per line instead of per marker
  // array - kept separate (levels refresh once per data load, walls on a
  // slower REST cadence) so refreshing one never has to touch the other's entries.
  let levelLinesByKey = new Map();
  let wallLinesByKey = new Map();
  let lastLiveUnixTime = null; // guards against feeding series.update() a time older than its last bar

  // the daily levels + scorecard, kept around so the nearest-level cards
  // can react to the real-time price, not just the initial data load.
  let activeLevels = [];
  let activeScorecard = null;
  let activeProximity = null;
  let activeOrderBookWalls = null;
  let activeLiquidationBins = []; // {price_low, price_high, long_intensity, short_intensity} - a model, not real position data, see renderLiquidationHeatmap()
  const liquidationEls = []; // kept separate from overlayEls - purely visual, never clickable/decluttered/part of currentMarkers
  let liquidationLayerEl = null; // the blurred wrapper all liquidation rows render into, created once and reused
  let tradeMarkersPlugin = null;
  let activeCandles = []; // current timeframe's loaded candles, so trade markers can be bounds-checked
  let markingMode = false;
  let pendingTrade = null; // {time, price} captured from a chart click, awaiting form submission
  let lastLivePrice = null; // most recent known price, for live P&L on sized/leveraged trades
  let previousLivePrice = null; // gives the on-chart ticker a quiet up/down cue without implying a signal
  let lastLiveTickAt = null; // latest WebSocket trade-event time, used to expose freshness instead of just saying "Live"
  let activeRangeDecision = null; // sourced BTC macro range (or rolling fallback for other assets) drawn behind the candles
  let activePatienceGate = null;
  let activeStrategyRange = RangeDecision.BTC_MACRO_RANGE; // daily-calculated structural reclaim layered onto the dated macro framework
  let activeRangeLabData = null;
  let activeRangeLabCandidateKey = null;
  const rangeLabPriceLines = [];
  let closingTradeId = null; // trade mid-close (exit-price input showing in its row), survives live derived-panel refreshes
  let deletingTradeId = null; // trade awaiting delete confirmation (same survive-the-re-render need as closingTradeId) - deleting is permanent, localStorage-only, no undo
  let snappedMarkerKey = null; // key of whichever marker (table row, dropdown pick, or on-chart label) the price scale is currently locked to, if any
  let activeLevelsWindowDays = null; // RANGE_DAYS from the levels JSON, for the 4H default-zoom calc
  let lastOverlayPriceRange = null; // {from, to} as of the last renderOverlays() call, for the price-scale poll below
  let macroRangeFramedKey = null; // frame the sourced BTC range once per chart load without fighting later manual zooms
  let macroAutoPriceRange = null; // last range set by macro framing; live ticks may extend only this untouched automatic view

  function ensureChart() {
    if (chart) return;
    const container = document.getElementById("chart-container");
    chart = LightweightCharts.createChart(container, {
      autoSize: true,
      layout: {
        // Transparent, not --surface: the library paints this as a
        // genuinely opaque fill across the whole pane before anything
        // else, which sits at z-index 2 - any z-index below that (the
        // liquidation heatmap) was being permanently hidden by this fill
        // alone, independent of candles or grid being drawn over it.
        // #chart-container's own CSS background (var(--surface), set in
        // styles.css) still shows through underneath everything, so the
        // visual result where nothing else is drawn is unchanged.
        background: { type: "solid", color: "rgba(0, 0, 0, 0)" },
        textColor: cssVar("--text"),
      },
      grid: {
        vertLines: { color: cssVar("--border") },
        horzLines: { color: cssVar("--border") },
      },
      // Keep a subtle horizontal crosshair and its right-axis label so
      // the mouse always answers "what price is this height?". Its thin,
      // neutral dotted styling distinguishes this temporary hover guide
      // from the colored strategy levels and the green live-price line.
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
        horzLine: {
          visible: true,
          labelVisible: true,
          color: "rgba(205, 214, 208, 0.62)",
          width: 1,
          style: LightweightCharts.LineStyle.Dotted,
          labelBackgroundColor: cssVar("--surface-strong"),
        },
      },
      // minBarSpacing's default (0.5px/candle) physically caps how much
      // history fitContent() can ever show: with Daily now carrying over
      // 4000 candles (see COINBASE_* above) against an ~1100px-wide
      // plot, showing all of them needs ~0.27px/candle - below the
      // default floor, so fitContent() was silently clamping to only the
      // most recent ~2100 candles instead of the full history, no error,
      // just quietly not what was asked for. Confirmed directly: logged
      // the actual visible logical range after a real deep-history load
      // and it stopped partway through the data every time. Lowered the
      // floor so multi-year compression is possible - individual candles
      // get thin, which is the correct tradeoff for a decade-scale
      // overview, not a bug to work around.
      timeScale: { timeVisible: true, borderColor: cssVar("--border"), minBarSpacing: 0.05 },
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
      priceLineWidth: 2,
      priceLineStyle: LightweightCharts.LineStyle.Dotted,
    });

    volumeSeries = chart.addSeries(LightweightCharts.HistogramSeries, {
      color: cssVar("--text-muted"),
      priceFormat: { type: "volume" },
      priceScaleId: "",
      // every series shows its own "latest value" axis label by default -
      // volume's own (e.g. "3.27K") was showing up right in among the
      // actual price labels, looking like a stray/broken price reading.
      lastValueVisible: false,
    });
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

    tradeMarkersPlugin = LightweightCharts.createSeriesMarkers(candleSeries, []);
    chart.subscribeClick(handleChartClick);
    // Keep the exact price beside the cursor as well as on the right axis,
    // so reading a candle does not require moving your eyes across the
    // entire chart. Clamp it inside the candle pane and flip it to the
    // cursor's left near the price scale.
    chart.subscribeCrosshairMove((param) => {
      const cursorPrice = document.getElementById("chart-cursor-price");
      const point = param.point;
      const price = point ? candleSeries.coordinateToPrice(point.y) : null;
      if (!cursorPrice || !point || !Number.isFinite(price)) {
        if (cursorPrice) cursorPrice.hidden = true;
        if (!markingMode) container.style.cursor = "default";
        return;
      }

      cursorPrice.textContent = `$${price.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;
      cursorPrice.hidden = false;

      const paneRight = container.clientWidth - candleSeries.priceScale().width();
      const tooltipWidth = cursorPrice.offsetWidth;
      const tooltipHeight = cursorPrice.offsetHeight;
      let left = point.x + 14;
      if (left + tooltipWidth > paneRight - 8) left = point.x - tooltipWidth - 14;
      left = Math.max(8, Math.min(left, paneRight - tooltipWidth - 8));
      let top = point.y - tooltipHeight - 12;
      if (top < 8) top = point.y + 14;
      top = Math.max(8, Math.min(top, container.clientHeight - tooltipHeight - 8));
      cursorPrice.style.left = `${left}px`;
      cursorPrice.style.top = `${top}px`;

      // Hover feedback for "click the line itself" - the cursor becomes a
      // pointer only when it is close enough to a drawn level to select.
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
        const marker = currentMarkers.find((candidate) => candidate.key === key);
        const labelVisible = !marker || marker.showLabel !== false || key === snappedMarkerKey;
        const selectedColor = marker && key === snappedMarkerKey ? marker.focusColor || marker.color : marker && marker.color;
        for (const line of lines) {
          line.applyOptions({
            lineVisible: visible,
            axisLabelVisible: visible && labelVisible,
            ...(selectedColor ? { color: selectedColor } : {}),
          });
        }
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

  function fullAnalysisIsOpen() {
    const details = document.getElementById("advanced-analysis");
    return Boolean(details && details.open);
  }

  function nearbyContextIsOpen() {
    const details = document.getElementById("nearby-context");
    return Boolean(details && details.open);
  }

  function levelsForCurrentView(levels) {
    if (state.asset === "btc" && !fullAnalysisIsOpen() && !nearbyContextIsOpen()) return [];
    if (fullAnalysisIsOpen() || !Number.isFinite(lastLivePrice)) return levels;
    const { nearestAbove, nearestBelow } = findNearestAboveBelow(levels, lastLivePrice);
    const touching = levels.filter((level) => lastLivePrice >= level.price_low && lastLivePrice <= level.price_high);
    return [...new Map([nearestBelow, ...touching, nearestAbove].filter(Boolean).map((level) => [levelKey(level), level])).values()];
  }

  function colorWithAlpha(color, alpha) {
    const match = String(color || "").trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!match) return color;
    const hex = match[1].length === 3
      ? match[1].split("").map((character) => character + character).join("")
      : match[1];
    const value = Number.parseInt(hex, 16);
    return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
  }

  function isRangeEdge(level) {
    return level.name.split(" + ").some((name) => /^Range (low|high)/i.test(name.trim()));
  }

  function updateChartFocusStatus() {
    const status = document.getElementById("chart-focus-status");
    if (!status) return;
    let message;
    if (state.asset === "spy") {
      message = "SPY historical backtest · not live";
    } else if (fullAnalysisIsOpen()) {
      message = "Level radar · reacts to the real-time price";
    } else {
      message = state.asset === "btc"
        ? "BTC macro range $60k–$80k · real-time Kraken stream"
        : "Rolling range · real-time Kraken stream";
    }
    if (status.textContent !== message) status.textContent = message;
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

    const visibleLevels = levelsForCurrentView(levels);
    const fullAnalysis = fullAnalysisIsOpen();
    const { nearestAbove, nearestBelow } = Number.isFinite(lastLivePrice)
      ? findNearestAboveBelow(levels, lastLivePrice)
      : { nearestAbove: null, nearestBelow: null };
    const touching = levels.filter((level) => lastLivePrice >= level.price_low && lastLivePrice <= level.price_high);
    const activeKeys = new Set([nearestBelow, ...touching, nearestAbove].filter(Boolean).map(levelKey));

    for (const level of visibleLevels) {
      const baseStyle = styleForLevel(level);
      const isZone = level.price_high > level.price_low;
      const label = `${level.name} (${level.strength}) — ${formatPriceRange(level.price_low, level.price_high)}`;
      const key = levelKey(level);
      const isActive = activeKeys.has(key);
      const isMajorRangeEdge = isRangeEdge(level);
      const emphasized = !fullAnalysis || isActive || isMajorRangeEdge;
      const style = {
        ...baseStyle,
        color: emphasized ? baseStyle.color : colorWithAlpha(baseStyle.color, 0.18),
        lineWidth: isActive ? Math.max(baseStyle.lineWidth, 3) : (isMajorRangeEdge ? 2 : 1),
      };
      const showLabel = emphasized;

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
          axisLabelVisible: showLabel,
          title: "",
        });
        const bottom = candleSeries.createPriceLine({
          price: level.price_low,
          color: style.color,
          lineWidth: style.lineWidth,
          lineStyle: style.lineStyle,
          axisLabelVisible: showLabel,
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
          axisLabelVisible: showLabel,
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
        focusColor: baseStyle.color,
        label,
        isZone,
        emphasized,
        showLabel,
      });
    }
    updateChartFocusStatus();

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

  const LIQUIDATION_MAX_OPACITY = 0.32;
  const LIQUIDATION_DISPLAY_THRESHOLD = 0.8;
  const LIQUIDATION_CONTRAST_EXPONENT = 2.2;
  const LIQUIDATION_SMOOTHING_RADIUS = 4;

  // A real background heatmap, not a side gutter - the user pointed at a
  // Coinglass-style screenshot (full-width horizontal bands sitting
  // behind the candles) and said a narrow strip off to the side "doesn't
  // help." Each bin becomes one full-width translucent row, z-indexed
  // below the chart's own canvas so candles/grid draw on top of it, same
  // as the reference image. One color per row (whichever side - long or
  // short - is hotter there), not two overlapping tints: real liquidation
  // heatmaps read as a single clean gradient, and overlapping red+green
  // at partial opacity turns to visual mud rather than information.
  // Deliberately NOT part of currentMarkers: there can be 100+ bins, and
  // treating them as clickable/decluttered "levels" the way real levels
  // are would wreck that system and the table/dropdown. Purely a
  // background visual, same as the always-on current-price line -
  // unaffected by isolate.
  function renderLiquidationHeatmap(container) {
    if (!liquidationLayerEl) {
      liquidationLayerEl = document.createElement("div");
      liquidationLayerEl.className = "liquidation-heatmap-layer";
      container.appendChild(liquidationLayerEl);
    }
    for (const el of liquidationEls) el.remove();
    liquidationEls.length = 0;
    if (!fullAnalysisIsOpen()) return;
    if (!activeLiquidationBins.length || !candleSeries) return;

    const containerHeight = container.clientHeight;

    const riskRows = LiquidationRisk.buildRiskRows(activeLiquidationBins, {
      smoothingRadius: LIQUIDATION_SMOOTHING_RADIUS,
      threshold: LIQUIDATION_DISPLAY_THRESHOLD,
    });

    // Preserve the model's global ranking. Previously, the visible slice
    // was rescaled to its own peak, which could make a weak local patch look
    // maximally hot whenever the true hotspot was off-screen.
    const visible = [];
    for (const risk of riskRows) {
      if (!risk.significant) continue;
      const bin = risk.bin;
      const yTop = candleSeries.priceToCoordinate(bin.price_high);
      const yBottom = candleSeries.priceToCoordinate(bin.price_low);
      if (yTop === null || yBottom === null) continue;
      if (yBottom < 0 || yTop > containerHeight) continue;
      visible.push({ risk, yTop, yBottom });
    }
    if (!visible.length) return;

    const axisWidth = candleSeries.priceScale().width();

    for (const { risk, yTop, yBottom } of visible) {
      const { bin, side, relative } = risk;
      const height = Math.max(1, yBottom - yTop);

      const row = document.createElement("div");
      row.className = `liquidation-row ${side}`;
      row.style.top = `${yTop}px`;
      row.style.height = `${height}px`;
      row.style.right = `${axisWidth}px`;
      row.style.opacity = LiquidationRisk.opacityForRelative(relative, {
        threshold: LIQUIDATION_DISPLAY_THRESHOLD,
        maxOpacity: LIQUIDATION_MAX_OPACITY,
        exponent: LIQUIDATION_CONTRAST_EXPONENT,
      });
      row.title = `Modeled ${side}-liquidation risk near ${formatPriceRange(bin.price_low, bin.price_high)} · ${Math.round(relative * 100)}% of model peak · not real position data`;
      liquidationLayerEl.appendChild(row);
      liquidationEls.push(row);
    }
  }

  function appendActiveRangeOverlay(container) {
    const decision = activeRangeDecision;
    if (snappedMarkerKey || state.asset === "spy" || !decision || !decision.support || !decision.resistance) return;

    const zonePrices = RangeDecision.rangeZonePrices(decision);
    if (!zonePrices) return;
    const { low: rangeLow, high: rangeHigh, longThreshold, shortThreshold } = zonePrices;

    const yTop = candleSeries.priceToCoordinate(rangeHigh);
    const yBottom = candleSeries.priceToCoordinate(rangeLow);
    if (yTop === null || yBottom === null || yBottom < 0 || yTop > container.clientHeight) return;

    const clippedTop = Math.max(0, yTop);
    const clippedBottom = Math.min(container.clientHeight, yBottom);
    const axisWidth = candleSeries.priceScale().width();
    const yShortThreshold = candleSeries.priceToCoordinate(shortThreshold);
    const yLongThreshold = candleSeries.priceToCoordinate(longThreshold);
    if (yShortThreshold === null || yLongThreshold === null) return;

    const band = document.createElement("div");
    band.className = "active-range-overlay";
    const visibleHeight = Math.max(1, clippedBottom - clippedTop);
    band.style.top = `${clippedTop}px`;
    band.style.height = `${visibleHeight}px`;
    band.style.right = `${axisWidth}px`;
    band.classList.toggle("is-compact", visibleHeight < 90);
    const clampY = (coordinate) => Math.max(clippedTop, Math.min(clippedBottom, coordinate));
    const zones = Array.isArray(zonePrices.segments)
      ? zonePrices.segments.map((segment) => ({
          className: `active-range-${segment.kind}`,
          label: segment.kind === "short" ? "Resistance area" : segment.kind === "long" ? "Support area" : "Wait",
          top: clampY(candleSeries.priceToCoordinate(segment.high)),
          bottom: clampY(candleSeries.priceToCoordinate(segment.low)),
        }))
      : [
          { className: "active-range-short", label: "Resistance area", top: clippedTop, bottom: clampY(yShortThreshold) },
          { className: "active-range-wait", label: "Wait", top: clampY(yShortThreshold), bottom: clampY(yLongThreshold) },
          { className: "active-range-long", label: "Support area", top: clampY(yLongThreshold), bottom: clippedBottom },
        ];
    for (const zone of zones) {
      const zoneElement = document.createElement("span");
      zoneElement.className = `active-range-zone ${zone.className}`;
      zoneElement.style.top = `${zone.top - clippedTop}px`;
      zoneElement.style.height = `${Math.max(0, zone.bottom - zone.top)}px`;
      zoneElement.textContent = zone.label;
      band.appendChild(zoneElement);
    }

    if (!Array.isArray(zonePrices.segments) && Number.isFinite(zonePrices.supportLow) && Number.isFinite(zonePrices.supportHigh)) {
      const ySupportTop = candleSeries.priceToCoordinate(zonePrices.supportHigh);
      const ySupportBottom = candleSeries.priceToCoordinate(zonePrices.supportLow);
      if (ySupportTop !== null && ySupportBottom !== null) {
        const supportTop = Math.max(clippedTop, Math.min(clippedBottom, ySupportTop));
        const supportBottom = Math.max(clippedTop, Math.min(clippedBottom, ySupportBottom));
        const supportBand = document.createElement("span");
        supportBand.className = "macro-support-zone";
        supportBand.style.top = `${supportTop - clippedTop}px`;
        supportBand.style.height = `${Math.max(1, supportBottom - supportTop)}px`;
        supportBand.textContent = "Decision support · wait for reclaim";
        band.appendChild(supportBand);
      }
    }

    if (decision.strategyRange) {
      const midpointPrice = (decision.strategyRange.low + decision.strategyRange.high) / 2;
      const yMidpoint = candleSeries.priceToCoordinate(midpointPrice);
      if (yMidpoint !== null && yMidpoint >= clippedTop && yMidpoint <= clippedBottom) {
        const midpointLine = document.createElement("span");
        midpointLine.className = "macro-midpoint-line";
        midpointLine.style.top = `${yMidpoint - clippedTop}px`;
        midpointLine.textContent = `Midpoint · ${formatPriceRange(midpointPrice, midpointPrice)}`;
        band.appendChild(midpointLine);
      }
    }
    container.appendChild(band);
    overlayEls.push(band);

    const boundaries = decision.strategyRange
      ? [
          { y: candleSeries.priceToCoordinate(decision.strategyRange.reclaim), side: "reclaim", price: decision.strategyRange.reclaim, name: decision.strategyRange.isCalculatedReclaim ? "Calculated structural reclaim" : "Bias-changing reclaim" },
          { y: candleSeries.priceToCoordinate(decision.strategyRange.high), side: "high", price: decision.strategyRange.high, name: "Macro range ceiling" },
          { y: candleSeries.priceToCoordinate(decision.strategyRange.low), side: "low", price: decision.strategyRange.low, name: "Macro range floor" },
        ]
      : [
          { y: yTop, side: "high", price: rangeHigh, name: decision.resistance.name },
          { y: yBottom, side: "low", price: rangeLow, name: decision.support.name },
        ];
    for (const boundary of boundaries) {
      if (boundary.y === null || boundary.y < 0 || boundary.y > container.clientHeight) continue;
      const label = document.createElement("div");
      label.className = `active-range-boundary active-range-boundary-${boundary.side}`;
      label.style.top = `${boundary.y}px`;
      label.style.right = `${axisWidth + 8}px`;
      label.textContent = `${boundary.name} · ${formatPriceRange(boundary.price, boundary.price)}`;
      label.title = boundary.name;
      container.appendChild(label);
      overlayEls.push(label);
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
    appendActiveRangeOverlay(container);

    // zone shading draws at its exact price - only the text tags get
    // decluttered below.
    for (const marker of currentMarkers) {
      if (!marker.isZone) continue;
      if (marker.emphasized === false && marker.key !== snappedMarkerKey) continue;
      if (snappedMarkerKey && marker.key !== snappedMarkerKey) continue; // isolated: only the selected marker's own zone shows
      const yTop = candleSeries.priceToCoordinate(marker.high);
      const yBottom = candleSeries.priceToCoordinate(marker.low);
      if (yTop === null || yBottom === null) continue;

      const band = document.createElement("div");
      band.className = "zone-overlay";
      band.style.top = `${yTop}px`;
      band.style.height = `${Math.max(1, yBottom - yTop)}px`;
      band.style.background = marker.key === snappedMarkerKey ? marker.focusColor || marker.color : marker.color;
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
      .filter((marker) => marker.showLabel !== false || marker.key === snappedMarkerKey)
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
        leader.style.background = marker.key === snappedMarkerKey ? marker.focusColor || marker.color : marker.color;
        container.appendChild(leader);
        overlayEls.push(leader);
      }

      const tick = document.createElement("div");
      tick.className = "level-label-leader-tick";
      tick.style.top = `${clampedTrueY}px`;
      tick.style.background = marker.key === snappedMarkerKey ? marker.focusColor || marker.color : marker.color;
      container.appendChild(tick);
      overlayEls.push(tick);

      const isSelected = marker.key === snappedMarkerKey;
      const tag = document.createElement("div");
      tag.className = `level-label${isSelected ? " level-label-selected" : ""}`;
      tag.style.top = `${y}px`;
      tag.style.background = isSelected ? marker.focusColor || marker.color : marker.color;
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

    // Daily now spans over a decade (see the deep-history fetch above) -
    // BTC/ETH have moved through multiple orders of magnitude in that
    // time, so a linear scale squashes everything before ~2020 into a
    // flat line hugging the bottom, visually invisible next to recent
    // prices. Logarithmic makes a swing from $300 to $1,000 (3x) read as
    // the same size move as $30,000 to $100,000 (also 3x) - which is
    // what it actually was. Other timeframes stay linear, where this
    // doesn't apply and would look unusual for a short window.
    candleSeries.priceScale().applyOptions({
      mode: range === "1d" ? LightweightCharts.PriceScaleMode.Logarithmic : LightweightCharts.PriceScaleMode.Normal,
    });

    activeLevelsWindowDays = levelsWindowDays;
    macroRangeFramedKey = null;
    macroAutoPriceRange = null;
    applyDefaultZoom(candleData.length, range, levelsWindowDays);

    // Seed the guard to the last rendered candle's true time rather than
    // nulling it out - nulling disabled the guard entirely for the very
    // next poll, which could then "update" an older candle from its own
    // last-2-rows batch before the current one, hitting the exact
    // older-than-last-bar error this guard exists to prevent.
    lastLiveUnixTime = candles.length ? candles[candles.length - 1].time : null;
  }

  // --- real-time price and forming candle ---
  //
  // Historical candles still load once through REST, but the visible price
  // and current candle are driven by Kraken's public OHLC WebSocket. Kraken
  // publishes that channel on every trade, so the chart moves as the market
  // trades instead of waiting for a timer. A 10-second REST request remains
  // only as a reconnect fallback; it is skipped while the socket is healthy.

  let liveSocket = null;
  let liveSocketGeneration = 0;
  let liveReconnectTimer = null;
  let liveReconnectAttempt = 0;
  let liveStreamStatus = "reconnecting";
  let liveStreamSubscribed = false;
  let lastLiveMessageAt = null;
  let lastRenderedMarkFresh = null;
  let derivedRenderTimer = null;
  let pendingDerivedAsset = null;
  let pendingDerivedPrice = null;
  let liveIntervalsStarted = false;

  function setLiveBadge(status) {
    // status: "live" | "reconnecting"
    const badge = document.getElementById("live-badge");
    badge.hidden = false;
    badge.classList.toggle("is-stale", status === "reconnecting");
    badge.querySelector(".live-label").textContent = status === "reconnecting" ? "Reconnecting" : "Live";
    renderChartLiveTicker(status);
  }

  function liveAgeLabel() {
    if (!lastLiveTickAt) return "Connecting…";
    const ageSeconds = Math.max(0, Math.round((Date.now() - lastLiveTickAt) / 1000));
    if (ageSeconds < 2) return "Updated now";
    if (ageSeconds < 60) return `Updated ${ageSeconds}s ago`;
    return `Updated ${Math.floor(ageSeconds / 60)}m ago`;
  }

  function renderChartLiveTicker(status = liveStreamStatus) {
    const ticker = document.getElementById("chart-live-ticker");
    if (!ticker) return;
    const markFresh = liveMarkIsFresh();
    const headerBadge = document.getElementById("live-badge");
    if (headerBadge && state.asset !== "spy") {
      headerBadge.classList.toggle("is-stale", !markFresh);
      headerBadge.querySelector(".live-label").textContent = markFresh ? "Live" : "Last mark";
    }
    ticker.classList.toggle("is-reconnecting", !markFresh);
    ticker.classList.toggle("is-connecting", !Number.isFinite(lastLivePrice));
    ticker.classList.toggle("is-up", Number.isFinite(previousLivePrice) && lastLivePrice > previousLivePrice);
    ticker.classList.toggle("is-down", Number.isFinite(previousLivePrice) && lastLivePrice < previousLivePrice);
    document.getElementById("chart-live-asset").textContent = state.asset.toUpperCase();
    document.getElementById("chart-live-price").textContent = Number.isFinite(lastLivePrice)
      ? lastLivePrice.toLocaleString(undefined, { maximumFractionDigits: 2 })
      : "—";
    document.getElementById("chart-live-age").textContent = markFresh ? liveAgeLabel() : `${liveAgeLabel()} · last mark`;
    const liveEntryButton = document.getElementById("trade-live-btn");
    if (liveEntryButton) liveEntryButton.disabled = !markFresh;
    const paperLiveLabel = document.getElementById("paper-trader-live-label");
    if (paperLiveLabel && state.asset !== "spy") {
      paperLiveLabel.textContent = markFresh ? "Live price" : "Last price";
    }
    if (lastRenderedMarkFresh !== markFresh) {
      lastRenderedMarkFresh = markFresh;
      if (Number.isFinite(lastLivePrice)) updateLiveTradePnlCells(state.asset, lastLivePrice);
    }
  }

  function liveMarkIsFresh(now = Date.now()) {
    return state.asset !== "spy" && KrakenLive.markIsFresh(
      liveStreamStatus,
      liveStreamSubscribed,
      lastLiveMessageAt,
      now,
      LIVE_STREAM_STALE_MS
    );
  }

  function renderDerivedLiveState(asset, price) {
    if (state.asset !== asset || !Number.isFinite(price)) return;
    renderLevels(activeLevels);
    renderNearestLevels(activeLevels, activeScorecard, price);
    renderRangeDecision(activeLevels, activeScorecard, price);
    renderTradeMarkers(asset, state.range, activeCandles);
    renderRoundProximityBands(price, activeProximity);
    renderOrderBookWalls(activeOrderBookWalls);
    renderLevelJumpSelect(activeLevels, price, { preserveInteraction: true });
    updateLiveTradePnlCells(asset, price);
  }

  function scheduleDerivedLiveState(asset, price) {
    pendingDerivedAsset = asset;
    pendingDerivedPrice = price;
    if (derivedRenderTimer) return;
    derivedRenderTimer = setTimeout(() => {
      derivedRenderTimer = null;
      const nextAsset = pendingDerivedAsset;
      const nextPrice = pendingDerivedPrice;
      pendingDerivedAsset = null;
      pendingDerivedPrice = null;
      renderDerivedLiveState(nextAsset, nextPrice);
    }, DERIVED_RENDER_THROTTLE_MS);
  }

  function applyLiveCandle(candle, asset, range, source = "stream") {
    if (state.asset !== asset || state.range !== range || !candleSeries) return false;
    if (lastLiveUnixTime !== null && candle.time < lastLiveUnixTime) return false;

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
    const activeIndex = activeCandles.findIndex((item) => item.time === candle.time);
    if (activeIndex >= 0) activeCandles[activeIndex] = candle;
    else activeCandles.push(candle);
    lastLiveUnixTime = candle.time;

    document.getElementById("price-label").textContent = candle.close.toLocaleString(undefined, {
      maximumFractionDigits: 2,
    });
    previousLivePrice = lastLivePrice;
    lastLivePrice = candle.close;
    lastLiveTickAt = Date.now();
    if (source === "stream" || source === "snapshot") {
      liveStreamStatus = "live";
      setLiveBadge("live");
    } else {
      liveStreamStatus = "reconnecting";
      renderChartLiveTicker("reconnecting");
    }
    // Terminal paper events are state, not presentation. Evaluate every
    // accepted Kraken update before the 400ms rendering throttle so a quick
    // stop/target touch followed by a recovery cannot be overwritten by the
    // later pendingDerivedPrice. Subscription snapshots never settle trades:
    // they may contain historical candles rather than a new market event.
    if (source === "stream" && liveMarkIsFresh()) settleTriggeredTrades(asset, candle.close);
    scheduleDerivedLiveState(asset, candle.close);
    return true;
  }

  async function pollLiveCandleFallback() {
    if (state.asset === "spy") return;
    const streamIsFresh = KrakenLive.isStreamFresh(
      liveStreamSubscribed,
      lastLiveMessageAt,
      Date.now(),
      LIVE_STREAM_STALE_MS
    );
    if (streamIsFresh) return;
    if (liveStreamSubscribed || (liveSocket && !lastLiveMessageAt)) {
      // A socket can remain nominally open through a network handoff while
      // no longer delivering data. Kraken sends heartbeats, so 15 seconds
      // without any message (or one fallback interval without even an
      // acknowledgement) is enough to treat it as stalled, use REST for
      // this tick, and establish a fresh subscription.
      liveStreamSubscribed = false;
      liveStreamStatus = "reconnecting";
      setLiveBadge("reconnecting");
      const staleSocket = liveSocket;
      liveSocket = null;
      if (staleSocket) staleSocket.close();
      scheduleLiveReconnect(liveSocketGeneration);
    }
    const asset = state.asset;
    const range = state.range;
    const pair = ASSET_PAIRS[asset];
    const interval = RANGE_INTERVALS[range];

    try {
      const rows = await fetchKrakenCandles(pair, interval);
      if (!rows.length) return;

      // the toggle may have moved on to a different asset/range while this
      // request was in flight - if so, drop the result rather than draw it
      // onto the wrong series. Not a failure, so don't touch the miss count.
      if (state.asset !== asset || state.range !== range) return;

      // last 2 rows: the current forming candle, plus the previous one in
      // case it just closed between polls and we'd otherwise miss its
      // final close.
      for (const candle of rows.slice(-2)) applyLiveCandle(candle, asset, range, "fallback");
    } catch (err) {
      console.error("live REST fallback failed", err);
    }
  }

  async function refreshOrderBookWalls() {
    if (state.asset === "spy") return;
    const asset = state.asset;
    const range = state.range;
    const pair = ASSET_PAIRS[asset];
    try {
      const walls = await fetchOrderBookWalls(pair);
      if (state.asset === asset && state.range === range) renderOrderBookWalls(walls);
    } catch (err) {
      console.error("order book fetch failed", err);
    }
  }

  function clearLiveReconnectTimer() {
    if (!liveReconnectTimer) return;
    clearTimeout(liveReconnectTimer);
    liveReconnectTimer = null;
  }

  function scheduleLiveReconnect(generation) {
    if (generation !== liveSocketGeneration || state.asset === "spy" || liveReconnectTimer) return;
    liveStreamStatus = "reconnecting";
    liveStreamSubscribed = false;
    setLiveBadge("reconnecting");
    const delay = Math.min(1000 * (2 ** liveReconnectAttempt), LIVE_RECONNECT_MAX_MS);
    liveReconnectAttempt += 1;
    liveReconnectTimer = setTimeout(() => {
      liveReconnectTimer = null;
      if (generation === liveSocketGeneration) connectLiveStream();
    }, delay);
  }

  function connectLiveStream() {
    if (state.asset === "spy" || typeof WebSocket !== "function") return;
    clearLiveReconnectTimer();
    const generation = liveSocketGeneration;
    const asset = state.asset;
    const range = state.range;
    const symbol = ASSET_PAIRS[asset];
    const interval = RANGE_INTERVALS[range];
    liveStreamStatus = "reconnecting";
    liveStreamSubscribed = false;
    setLiveBadge("reconnecting");

    let socket;
    try {
      socket = new WebSocket(KrakenLive.URL);
    } catch (err) {
      console.error("live WebSocket creation failed", err);
      scheduleLiveReconnect(generation);
      return;
    }
    liveSocket = socket;
    socket.addEventListener("open", () => {
      if (generation !== liveSocketGeneration) return socket.close();
      socket.send(JSON.stringify(KrakenLive.subscriptionRequest(symbol, interval, generation)));
    });
    socket.addEventListener("message", (event) => {
      if (generation !== liveSocketGeneration || state.asset !== asset || state.range !== range) return;
      lastLiveMessageAt = Date.now();
      const message = KrakenLive.parseMessage(event.data, symbol, interval);
      if (!message) return;
      if (message.kind === "subscription") {
        if (!message.success) {
          console.error("Kraken live subscription failed", message.error);
          socket.close();
          return;
        }
        liveStreamSubscribed = true;
        liveStreamStatus = "live";
        liveReconnectAttempt = 0;
        setLiveBadge("live");
        return;
      }
      const source = message.type === "snapshot" ? "snapshot" : "stream";
      for (const candle of message.candles) applyLiveCandle(candle, asset, range, source);
    });
    socket.addEventListener("error", () => {
      if (generation === liveSocketGeneration) socket.close();
    });
    socket.addEventListener("close", () => {
      if (liveSocket === socket) liveSocket = null;
      scheduleLiveReconnect(generation);
    });
  }

  function restartLiveStream() {
    liveSocketGeneration += 1;
    const generation = liveSocketGeneration;
    clearLiveReconnectTimer();
    liveStreamSubscribed = false;
    lastLiveMessageAt = null;
    liveReconnectAttempt = 0;
    if (liveSocket) {
      const oldSocket = liveSocket;
      liveSocket = null;
      oldSocket.close();
    }
    if (state.asset === "spy") return;
    liveStreamStatus = "reconnecting";
    setLiveBadge("reconnecting");
    connectLiveStream();
  }

  function startLiveStreaming() {
    restartLiveStream();
    if (liveIntervalsStarted) return;
    liveIntervalsStarted = true;
    setInterval(pollLiveCandleFallback, FALLBACK_POLL_MS);
    setInterval(refreshOrderBookWalls, ORDER_BOOK_POLL_MS);
    setInterval(renderChartLiveTicker, 1000);
    setInterval(pollRangeLab, RANGE_LAB_POLL_MS);
    refreshOrderBookWalls();
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

  // --- range decision brief ---
  //
  // The linked video gives a useful risk frame (trade the edge of a range,
  // define a stop, use isolated margin) but no objective entry algorithm.
  // RangeDecision makes the one missing UI assumption explicit: the outer
  // 35% of the nearest support/resistance bracket is a WATCH area and the
  // middle 30% is WAIT. It does not detect confirmation or claim an edge.

  function compactPrice(value) {
    return value.toLocaleString(undefined, { maximumFractionDigits: value >= 1000 ? 0 : 2 });
  }

  function levelLabelWithPrice(level) {
    if (!level) return "—";
    const price = level.price_high > level.price_low
      ? `${compactPrice(level.price_low)}–${compactPrice(level.price_high)}`
      : compactPrice(level.price_low);
    return `${level.name} · ${price}`;
  }

  function fillDecisionScore(prefix, score) {
    const value = document.getElementById(`decision-${prefix}-odds`);
    const note = document.getElementById(`decision-${prefix}-note`);
    if (!score) {
      value.textContent = "No read";
      note.textContent = "historical score unavailable";
      return;
    }
    value.textContent = score.low === score.high
      ? `${score.low.toFixed(0)}% held`
      : `${score.low.toFixed(0)}–${score.high.toFixed(0)}% held`;
    note.textContent = `n=${score.resolved}${score.lowConfidence ? " · low confidence" : ""}`;
  }

  function setDecisionClass(status) {
    const brief = document.getElementById("decision-brief");
    brief.className = `decision-brief is-${status}`;
  }

  function renderDecisionLoading() {
    activeRangeDecision = null;
    activePatienceGate = null;
    const tradeForm = document.getElementById("trade-form");
    if (tradeForm && !tradeForm.hidden && pendingTrade) updateTradeRiskPreview();
    setDecisionClass("loading");
    document.getElementById("decision-badge").textContent = "Loading";
    document.getElementById("decision-method").textContent = state.asset === "btc" ? "BTC macro range" : "Current rolling range";
    document.getElementById("decision-source-link").hidden = true;
    document.getElementById("decision-title").textContent = "Building the current range read…";
    document.getElementById("decision-summary").textContent = "Waiting for price, levels, and historical context.";
    document.getElementById("decision-range").hidden = true;
    document.getElementById("patience-gate").hidden = true;
    document.getElementById("decision-metrics").hidden = true;
  }

  function renderDecisionUnavailable(message) {
    activeRangeDecision = null;
    activePatienceGate = null;
    setDecisionClass("wait");
    document.getElementById("decision-badge").textContent = "Data unavailable";
    document.getElementById("decision-method").textContent = "Waiting for complete data";
    document.getElementById("decision-source-link").hidden = true;
    document.getElementById("decision-title").textContent = "The range read could not be built";
    document.getElementById("decision-summary").textContent = message;
    document.getElementById("decision-range").hidden = true;
    document.getElementById("patience-gate").hidden = true;
    document.getElementById("decision-metrics").hidden = true;
    document.getElementById("decision-caveat").textContent =
      "A fetch failure is not a trading signal. Retry later rather than filling the gap with an assumption.";
    renderOverlays();
  }

  function setPatienceCondition(id, ready, detail) {
    const element = document.getElementById(id);
    element.classList.toggle("is-ready", ready);
    element.querySelector("b").textContent = detail;
  }

  function patienceAlertPermission() {
    if (!("Notification" in window)) return "unsupported";
    return Notification.permission;
  }

  function syncPatienceAlertControls() {
    const button = document.getElementById("patience-alert-toggle");
    const status = document.getElementById("patience-alert-status");
    if (!button || !status) return;
    const permission = patienceAlertPermission();
    button.setAttribute("aria-pressed", String(patienceAlertsEnabled));
    button.textContent = patienceAlertsEnabled ? "Disable alerts" : "Enable alerts";
    if (!patienceAlertsEnabled) status.textContent = "Off · no setup, boundary-change, or paper-observation notifications";
    else if (permission === "granted") status.textContent = "On · in-page and hidden-tab browser alerts";
    else if (permission === "denied") status.textContent = "On · in-page alert only (browser notifications blocked)";
    else if (permission === "unsupported") status.textContent = "On · in-page alert only on this device";
    else status.textContent = "On · permission not yet selected";
  }

  function alertedFingerprints() {
    try {
      const values = JSON.parse(readLocalStorage(PATIENCE_ALERTED_KEY, "[]"));
      const stored = Array.isArray(values) ? values : [];
      return [...new Set([...stored, ...patienceAlertMemory])];
    } catch (_) {
      return [...patienceAlertMemory];
    }
  }

  function rememberAlertFingerprint(fingerprint) {
    const next = [...alertedFingerprints().filter((value) => value !== fingerprint), fingerprint].slice(-20);
    patienceAlertMemory = next;
    writeLocalStorage(PATIENCE_ALERTED_KEY, JSON.stringify(next));
  }

  function hidePatienceToast() {
    const toast = document.getElementById("patience-alert-toast");
    if (toast) toast.hidden = true;
    if (patienceToastTimer) clearTimeout(patienceToastTimer);
    patienceToastTimer = null;
  }

  function showAlertToast(label, title, detail) {
    const toast = document.getElementById("patience-alert-toast");
    if (!toast) return;
    document.getElementById("patience-alert-toast-label").textContent = label;
    document.getElementById("patience-alert-toast-title").textContent = title;
    document.getElementById("patience-alert-toast-detail").textContent = detail;
    toast.hidden = false;
    if (patienceToastTimer) clearTimeout(patienceToastTimer);
    patienceToastTimer = setTimeout(hidePatienceToast, 12000);
  }

  function showPatienceToast(title, detail, direction) {
    showAlertToast(`Trade checklist · 3 of 3 · ${direction.toLowerCase()} setup`, title, detail);
  }

  function maybeSendPaperEventAlerts(data) {
    const current = RangeLab.paperEventSnapshot(data);
    let previous = null;
    try {
      previous = JSON.parse(readLocalStorage(PAPER_EVENT_STATE_KEY, "null"));
    } catch (_) {
      previous = null;
    }
    writeLocalStorage(PAPER_EVENT_STATE_KEY, JSON.stringify(current));
    if (!previous || !patienceAlertsEnabled) return;
    const events = RangeLab.paperEvents(previous, current)
      .filter((event) => !alertedFingerprints().includes(event.fingerprint));
    if (!events.length) return;
    for (const event of events) rememberAlertFingerprint(event.fingerprint);
    const title = events.length === 1
      ? `${events[0].label} paper observation ${events[0].kind}`
      : `${events.length} Range Lab paper observations changed`;
    const detail = events.map((event) => event.copy).join(" ");
    showAlertToast("RANGE LAB · PAPER OBSERVATION", title, detail);
    if (document.hidden && patienceAlertPermission() === "granted") {
      try {
        const notification = new Notification(title, {
          body: detail,
          tag: "range-desk-paper-observation",
          renotify: false,
        });
        notification.onclick = () => {
          window.focus();
          notification.close();
        };
      } catch (err) {
        console.error("paper-observation notification unavailable; in-page alert still shown", err);
      }
    }
  }

  function maybeSendPatienceAlert(decision, gateState) {
    if (!patienceAlertsEnabled || !gateState.isReady || !gateState.boundaryTest) return;
    const fingerprint = RangeDecision.patienceAlertFingerprint(state.asset, state.range, decision, gateState);
    if (!fingerprint) return;
    if (alertedFingerprints().includes(fingerprint)) return;
    rememberAlertFingerprint(fingerprint);

    const direction = decision.status === "long-watch" ? "LONG" : "SHORT";
    const assetLabel = state.asset.toUpperCase();
    const timeframeLabel = state.range === "1d" ? "Daily" : state.range.toUpperCase();
    const title = `${assetLabel} ${timeframeLabel} ${direction.toLowerCase()} setup confirmed`;
    const detail = `${gateState.boundary.name} was tested and a completed candle closed back inside. Review the stop and size before acting.`;
    showPatienceToast(title, detail, direction);

    if (document.hidden && patienceAlertPermission() === "granted") {
      try {
        const notification = new Notification(title, {
          body: detail,
          tag: `range-desk-${state.asset}-${state.range}`,
          renotify: false,
        });
        notification.onclick = () => {
          window.focus();
          notification.close();
        };
      } catch (err) {
        console.error("browser notification unavailable; in-page alert still shown", err);
      }
    }
  }

  function wirePatienceAlerts() {
    patienceAlertsEnabled = readLocalStorage(PATIENCE_ALERT_PREF_KEY, "false") === "true";
    syncPatienceAlertControls();
    document.getElementById("patience-alert-toast-close").addEventListener("click", hidePatienceToast);
    document.getElementById("patience-alert-toggle").addEventListener("click", async () => {
      patienceAlertsEnabled = !patienceAlertsEnabled;
      writeLocalStorage(PATIENCE_ALERT_PREF_KEY, String(patienceAlertsEnabled));
      if (patienceAlertsEnabled && patienceAlertPermission() === "default") {
        try {
          await Notification.requestPermission();
        } catch (err) {
          console.error("notification permission request failed; in-page alerts remain available", err);
        }
      }
      if (!patienceAlertsEnabled) hidePatienceToast();
      syncPatienceAlertControls();
      if (patienceAlertsEnabled && state.asset !== "spy" && activeLevels.length && Number.isFinite(lastLivePrice)) {
        renderRangeDecision(activeLevels, activeScorecard, lastLivePrice);
      }
    });
  }

  function renderPatienceGate(decision) {
    const gate = document.getElementById("patience-gate");
    gate.hidden = false;
    const gateState = RangeDecision.patienceState(decision, activeCandles);
    activePatienceGate = gateState;
    const { hasLocation, hasTouch, hasConfirmation, readyCount, boundary, boundaryTest } = gateState;
    const timeframeLabel = state.range === "1d" ? "Daily" : state.range.toUpperCase();

    setPatienceCondition(
      "patience-location",
      hasLocation,
      hasLocation ? (decision.status === "long-watch" ? "Near support" : "Near resistance") : "Not near a boundary"
    );
    setPatienceCondition(
      "patience-touch",
      hasTouch,
      hasTouch ? `${boundary.name} was tested ${boundaryTest.barsAgo === 0 ? `on the latest ${timeframeLabel} candle` : `${boundaryTest.barsAgo} ${timeframeLabel} candles ago`}` : hasLocation ? `Waiting for price to reach ${boundary.name}` : "No boundary selected"
    );
    setPatienceCondition(
      "patience-confirmation",
      hasConfirmation,
      hasConfirmation
        ? "Latest completed candle closed back inside the range"
        : boundaryTest && boundaryTest.confirmed
          ? "Earlier confirmation is no longer current"
          : hasTouch
            ? "Waiting for a confirming candle close"
            : "Waiting for the boundary test"
    );

    document.getElementById("patience-count").textContent = `${readyCount} of 3 conditions met`;
    const quickGuideStatus = document.getElementById("quick-guide-status");
    if (quickGuideStatus) {
      quickGuideStatus.textContent = readyCount === 3
        ? "All three conditions are visible. Review risk before making a decision."
        : `${readyCount} of 3 conditions met · patience is part of the process.`;
    }
    let instruction = "Price is between the important boundaries. Wait for it to reach an edge.";
    if (hasLocation && !hasTouch) instruction = `Price is in the right area, but it has not tested ${boundary.name} yet.`;
    if (hasTouch && !hasConfirmation) instruction = boundaryTest && boundaryTest.confirmed
      ? "The earlier confirmation is now stale. Wait for a new test instead of chasing price."
      : "The boundary was tested, but a completed candle has not closed back inside the range.";
    if (hasConfirmation) instruction = "All three conditions are visible. Review the stop, target, and position size before making any decision.";
    document.getElementById("patience-instruction").textContent = instruction;
    maybeSendPatienceAlert(decision, gateState);
    const tradeForm = document.getElementById("trade-form");
    if (tradeForm && !tradeForm.hidden && pendingTrade) updateTradeRiskPreview();
    return gateState;
  }

  function renderRangeDecision(levels, scorecard, currentPrice) {
    const decision = state.asset === "btc"
      ? RangeDecision.buildStrategyRange(currentPrice, activeStrategyRange, activeCandles)
      : RangeDecision.build(levels, scorecard, currentPrice);
    activeRangeDecision = decision;
    const gateState = renderPatienceGate(decision);
    setDecisionClass(decision.status);
    const isLong = decision.status === "long-watch";
    const isShort = decision.status === "short-watch";
    document.getElementById("decision-badge").textContent = gateState.isReady
      ? "3 conditions met"
      : isLong
        ? "Near support"
        : isShort
          ? "Near resistance"
          : "Wait";
    document.getElementById("decision-title").textContent = gateState.isReady
      ? "Conditions met — review the risk before entering"
      : isLong
        ? "Support area — wait for a confirmed reclaim"
        : isShort
          ? "Resistance area — wait for a confirmed rejection"
          : "Middle of the range — no location advantage";
    document.getElementById("decision-summary").textContent = gateState.isReady
      ? "The latest completed candle confirmed the boundary test. This is context to assess, not an automatic trade."
      : gateState.hasTouch
        ? "Price reached the boundary, but the completed candle has not confirmed a move back inside the range."
        : isLong || isShort
          ? "Price is near an important boundary. Let the market test and confirm it before planning an entry."
          : "Price is not close enough to either boundary. Waiting avoids forcing a trade in the least useful part of the range.";
    document.getElementById("decision-range").hidden = !decision.support || !decision.resistance;
    document.getElementById("decision-metrics").hidden = false;
    document.getElementById("decision-rr-label").textContent = "Range geometry";
    document.getElementById("decision-support-label").textContent = "Support history";
    document.getElementById("decision-resistance-label").textContent = "Resistance history";

    if (!decision.support || !decision.resistance) {
      document.getElementById("decision-method").textContent = "Insufficient bracket";
      document.getElementById("decision-source-link").hidden = true;
      document.getElementById("decision-rr").textContent = "No setup";
      document.getElementById("decision-rr-note").textContent = "wait for a complete range";
      fillDecisionScore("support", null);
      fillDecisionScore("resistance", null);
      document.getElementById("decision-caveat").textContent =
        "Do not manufacture an entry outside the known map. Refresh the data or wait for price to return inside a bracket.";
      renderOverlays();
      return;
    }

    const strategyTrackPosition = RangeDecision.strategyTrackPosition(decision, currentPrice);
    const bracketPct = (strategyTrackPosition === null ? decision.bracketPosition : strategyTrackPosition) * 100;
    const macroText = decision.strategyRange
      ? decision.strategyRange.isCalculatedReclaim
        ? `BTC macro framework · reclaim calculated from Daily pivots · ${state.range.toUpperCase()} candle confirmation`
        : `BTC macro range · sourced ${decision.strategyRange.sourceDate} · ${state.range.toUpperCase()} candle confirmation`
      : decision.macroPosition === null
        ? `Nearest support and resistance · ${state.range.toUpperCase()} candle confirmation`
        : `Nearest range · ${Math.round(decision.macroPosition * 100)}% through the 60-day range · ${state.range.toUpperCase()} candle confirmation`;
    document.getElementById("decision-method").textContent = macroText;
    const sourceLink = document.getElementById("decision-source-link");
    sourceLink.hidden = !decision.strategyRange || !decision.strategyRange.sourceUrl;
    if (!sourceLink.hidden) sourceLink.href = decision.strategyRange.sourceUrl;
    document.getElementById("decision-support-caption").textContent = decision.strategyRange ? "Macro floor" : "Support / invalidation";
    document.getElementById("decision-resistance-caption").textContent = decision.strategyRange ? "Ceiling / reclaim" : "Resistance / target";
    document.getElementById("decision-support").textContent = decision.strategyRange
      ? compactPrice(decision.strategyRange.low)
      : levelLabelWithPrice(decision.support);
    document.getElementById("decision-resistance").textContent = decision.strategyRange
      ? `${compactPrice(decision.strategyRange.high)} / ${compactPrice(decision.strategyRange.reclaim)}`
      : levelLabelWithPrice(decision.resistance);
    document.getElementById("decision-position").textContent = decision.strategyRange
      ? `${Math.round(decision.macroPosition * 100)}% through $60k–$80k`
      : `${Math.round(bracketPct)}% through bracket`;
    const decisionTrack = document.querySelector("#decision-range .range-track");
    decisionTrack.classList.toggle("is-macro", Boolean(decision.strategyRange));
    decisionTrack.style.background = decision.strategyRange
      ? "linear-gradient(to right, color-mix(in srgb, var(--support) 48%, transparent) 0 8.77%, color-mix(in srgb, var(--flip) 20%, transparent) 8.77% 52.63%, color-mix(in srgb, var(--support) 48%, transparent) 52.63% 74.56%, color-mix(in srgb, var(--flip) 20%, transparent) 74.56% 87.72%, color-mix(in srgb, var(--resistance) 48%, transparent) 87.72% 100%)"
      : "";
    document.getElementById("decision-marker").style.left = `${bracketPct}%`;

    if (decision.strategyRange) {
      const frameKey = `${state.asset}|${state.range}|${decision.strategyRange.sourceDate}|${decision.strategyRange.reclaim}`;
      if (state.range === "4h" && macroRangeFramedKey !== frameKey && candleSeries && activeCandles.length) {
        const recentBars = activeCandles.slice(-Math.max(1, (activeLevelsWindowDays || 60) * 6));
        const recentHigh = Math.max(...recentBars.map((candle) => candle.high));
        const recentLow = Math.min(...recentBars.map((candle) => candle.low));
        const top = Math.max(decision.strategyRange.reclaim * 1.03, recentHigh * 1.02);
        const bottom = Math.min(decision.strategyRange.low * 0.98, recentLow * 0.98);
        candleSeries.priceScale().setAutoScale(false);
        candleSeries.priceScale().setVisibleRange({ from: bottom, to: top });
        macroAutoPriceRange = { from: bottom, to: top };
        macroRangeFramedKey = frameKey;
      }
      const visiblePriceRange = candleSeries && candleSeries.priceScale().getVisibleRange();
      const automaticViewIsUntouched = visiblePriceRange && macroAutoPriceRange
        && Math.abs(visiblePriceRange.from - macroAutoPriceRange.from) < 0.01
        && Math.abs(visiblePriceRange.to - macroAutoPriceRange.to) < 0.01;
      if (!snappedMarkerKey && automaticViewIsUntouched
          && currentPrice < decision.strategyRange.low * 0.98 && currentPrice < visiblePriceRange.from) {
        macroAutoPriceRange = {
          from: currentPrice * 0.98,
          to: visiblePriceRange.to,
        };
        candleSeries.priceScale().setVisibleRange(macroAutoPriceRange);
      }
      document.getElementById("decision-rr-label").textContent = "Higher-timeframe bias";
      document.getElementById("decision-support-label").textContent = "Decision support";
      const reclaimText = compactPrice(decision.strategyRange.reclaim);
      const reclaimExactText = decision.strategyRange.isCalculatedReclaim
        ? decision.strategyRange.reclaim.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : reclaimText;
      document.getElementById("decision-resistance-label").textContent = decision.strategyRange.isCalculatedReclaim
        ? "Calculated structural reclaim"
        : "Bias-changing reclaim";
      const biasPresentation = RangeDecision.reclaimBiasPresentation(decision.strategyRange, currentPrice);
      document.getElementById("decision-rr").textContent = biasPresentation.label;
      document.getElementById("decision-rr-note").textContent = biasPresentation.note;
      document.getElementById("decision-support-odds").textContent = "$72k–$77k";
      document.getElementById("decision-support-note").textContent = `loss of ~$${compactPrice(decision.strategyRange.failureLevel)} raises sub-$70k risk`;
      document.getElementById("decision-resistance-odds").textContent = `$${reclaimExactText}`;
      document.getElementById("decision-resistance-note").textContent = decision.strategyRange.isCalculatedReclaim
        ? `${decision.strategyRange.reclaimPivotCount} Daily pivot highs · origin ${decision.strategyRange.reclaimOriginDate}`
        : "acceptance above changes the lower-bias thesis";
      document.getElementById("decision-caveat").textContent = decision.status === "long-watch"
        ? "Near support does not mean buy. Wait for a test and a completed candle close back above support before assessing risk and size."
        : decision.status === "short-watch"
          ? "Near resistance does not mean sell. Wait for rejection and a completed candle close back below resistance before assessing risk and size."
          : "The range supplies location, not certainty. Wait for an edge and completed-candle confirmation instead of trading every nearby level.";
      renderOverlays();
      return;
    }

    if (decision.status === "long-watch") {
      document.getElementById("decision-rr").textContent = `${decision.longRewardRisk.toFixed(2)}:1 long geometry`;
      document.getElementById("decision-rr-note").textContent = "target distance vs. boundary; not position R";
      document.getElementById("decision-caveat").textContent =
        `Invalidation: sustained trade below ${decision.support.name}. First range target: ${decision.resistance.name}. The source discussed 1–5% risk and called 5% aggressive; this paper tool applies a stricter 2% ceiling.`;
    } else if (decision.status === "short-watch") {
      document.getElementById("decision-rr").textContent = `${decision.shortRewardRisk.toFixed(2)}:1 short geometry`;
      document.getElementById("decision-rr-note").textContent = "target distance vs. boundary; not position R";
      document.getElementById("decision-caveat").textContent =
        `Invalidation: sustained trade above ${decision.resistance.name}. First range target: ${decision.support.name}. The source discussed 1–5% risk and called 5% aggressive; this paper tool applies a stricter 2% ceiling.`;
    } else {
      document.getElementById("decision-rr").textContent =
        `${decision.longRewardRisk.toFixed(2)}:1 L · ${decision.shortRewardRisk.toFixed(2)}:1 S`;
      document.getElementById("decision-rr-note").textContent = "neither side is at the range edge";
      document.getElementById("decision-caveat").textContent =
        "The middle 30% is intentionally a no-trade area in this UI. This threshold is a transparent geometry filter, not a backtested signal.";
    }

    fillDecisionScore("support", decision.supportScore);
    fillDecisionScore("resistance", decision.resistanceScore);
    renderOverlays();
  }

  function clearRangeLabLines() {
    if (!candleSeries) return;
    for (const line of rangeLabPriceLines.splice(0)) {
      candleSeries.removePriceLine(line);
    }
  }

  function drawRangeLabCandidate(candidate) {
    clearRangeLabLines();
    if (!candleSeries || !candidate || !candidate.latest_range) return;
    const current = candidate.latest_range;
    const label = candidate.spec.label.toUpperCase();
    rangeLabPriceLines.push(
      candleSeries.createPriceLine({
        price: current.low,
        color: cssVar("--support"),
        lineWidth: 2,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true,
        title: `${label} LOW`,
      }),
      candleSeries.createPriceLine({
        price: current.midpoint,
        color: cssVar("--text-muted"),
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dotted,
        axisLabelVisible: false,
        title: `${label} MID`,
      }),
      candleSeries.createPriceLine({
        price: current.high,
        color: cssVar("--resistance"),
        lineWidth: 2,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true,
        title: `${label} HIGH`,
      })
    );
  }

  function selectRangeLabCandidate(key) {
    if (!activeRangeLabData) return;
    const view = RangeLab.viewModel(activeRangeLabData, key);
    const candidate = RangeLab.candidateByKey(activeRangeLabData, key);
    if (!view || !candidate) return;
    activeRangeLabCandidateKey = key;
    document.querySelectorAll(".range-lab-option").forEach((button) => {
      const active = button.dataset.rangeKey === key;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    document.getElementById("range-lab-detail").hidden = false;
    document.getElementById("range-lab-current").textContent =
      `${formatPriceRange(view.range.low, view.range.high)} · ${formatPriceRange(view.range.width, view.range.width)} wide`;
    document.getElementById("range-lab-current-status").textContent = view.range.status;
    document.getElementById("range-lab-trades").textContent = String(view.holdout.trades);
    document.getElementById("range-lab-expectancy").textContent = view.expectancy;
    document.getElementById("range-lab-profit-factor").textContent = view.profitFactor;
    document.getElementById("range-lab-drawdown").textContent =
      Number.isFinite(view.holdout.max_drawdown_pct) ? `${view.holdout.max_drawdown_pct}%` : "—";
    document.getElementById("range-lab-paper-trades").textContent = String(view.paper.metrics.trades);
    document.getElementById("range-lab-paper-expectancy").textContent = view.paperExpectancy;
    document.getElementById("range-lab-paper-profit-factor").textContent = view.paperProfitFactor;
    document.getElementById("range-lab-paper-status").textContent = view.paperStatus;
    const gatePanel = document.getElementById("range-forward-gate");
    gatePanel.hidden = !view.forwardGate;
    gatePanel.classList.toggle("is-qualified", Boolean(view.forwardGate && view.forwardGate.qualified));
    if (view.forwardGate) {
      const gate = view.forwardGate;
      document.getElementById("range-forward-gate-status").textContent = gate.status;
      document.getElementById("range-forward-gate-score").textContent = `${gate.passedChecks} / ${gate.totalChecks} CHECKS`;
      document.getElementById("range-forward-progress-count").textContent = `${gate.closed} / ${gate.required} CLOSED`;
      document.getElementById("range-forward-progress-percent").textContent = `${gate.progress}%`;
      const progress = document.querySelector(".range-forward-progress");
      progress.setAttribute("aria-valuemax", String(gate.required));
      progress.setAttribute("aria-valuenow", String(gate.closed));
      document.getElementById("range-forward-progress-bar").style.width = `${Math.max(0, Math.min(100, gate.progress))}%`;
      const checks = document.getElementById("range-forward-checks");
      checks.innerHTML = "";
      for (const check of gate.checks) {
        const card = document.createElement("article");
        card.className = `range-forward-check ${check.passed ? "is-passed" : "is-waiting"}`;
        const label = document.createElement("strong");
        label.textContent = `${check.passed ? "✓" : "○"} ${check.label}`;
        const detail = document.createElement("small");
        detail.textContent = check.detail;
        card.append(label, detail);
        checks.appendChild(card);
      }
    }
    const exitTest = document.getElementById("range-lab-exit-test");
    exitTest.hidden = !view.exitComparison;
    if (view.exitComparison) {
      document.getElementById("range-lab-exit-base-validation").textContent = view.exitComparison.baselineValidation;
      document.getElementById("range-lab-exit-runner-validation").textContent = view.exitComparison.runnerValidation;
      document.getElementById("range-lab-exit-base-holdout").textContent = view.exitComparison.baselineHoldout;
      document.getElementById("range-lab-exit-runner-holdout").textContent = view.exitComparison.runnerHoldout;
      document.getElementById("range-lab-exit-runner-sample").textContent = `${view.exitComparison.runnerHoldoutTrades} trades`;
      document.getElementById("range-lab-exit-runner-pf").textContent = view.exitComparison.runnerHoldoutProfitFactor;
      document.getElementById("range-lab-exit-verdict").textContent = view.exitComparison.validationEligible
        ? "Runner cleared the historical validation gate, but this second-round holdout was already visible and is not prospective proof."
        : "Runner did not clear the historical validation gate. A favorable old holdout result is not actionable evidence.";
    }
    const walkForward = document.getElementById("range-lab-walk-forward");
    walkForward.hidden = !view.walkForward;
    if (view.walkForward) {
      const status = document.getElementById("range-lab-walk-forward-status");
      status.textContent = view.walkForward.stable ? "HISTORICALLY STABLE · SHOW" : "NOT STABLE · SHOW";
      status.className = view.walkForward.stable ? "is-stable" : "is-failed";
      document.getElementById("range-lab-walk-eligible").textContent = `${view.walkForward.eligibleWindows} / 7`;
      document.getElementById("range-lab-walk-positive").textContent =
        `${view.walkForward.positiveWindows} · ${view.walkForward.positiveShare}`;
      document.getElementById("range-lab-walk-trades").textContent = String(view.walkForward.aggregateTrades);
      document.getElementById("range-lab-walk-expectancy").textContent = view.walkForward.aggregateExpectancy;
      document.getElementById("range-lab-walk-pf").textContent = view.walkForward.aggregateProfitFactor;
      document.getElementById("range-lab-walk-drawdown").textContent = view.walkForward.aggregateDrawdown;
      const windows = document.getElementById("range-lab-walk-windows");
      windows.innerHTML = "";
      for (const window of view.walkForward.windows) {
        const card = document.createElement("article");
        card.className = `range-lab-walk-window ${window.sampleEligible ? (window.positive ? "is-positive" : "is-negative") : "is-low-sample"}`;
        const heading = document.createElement("div");
        const label = document.createElement("strong");
        label.textContent = window.label;
        const regime = document.createElement("span");
        regime.textContent = `${window.regime.toUpperCase()} · ${window.marketReturn}`;
        heading.append(label, regime);
        const result = document.createElement("small");
        result.textContent = `${window.trades} trades · ${window.expectancy} · PF ${window.profitFactor}${window.sampleEligible ? "" : " · LOW SAMPLE"}`;
        card.append(heading, result);
        windows.appendChild(card);
      }
      document.getElementById("range-lab-walk-verdict").textContent = view.walkForward.stable
        ? "Passed the frozen historical stability screen, but this is still already-viewed history—not prospective proof or a trade instruction."
        : "Did not pass the frozen historical stability screen. Do not treat isolated positive windows as a live edge or trade instruction.";
    }
    const robustness = document.getElementById("range-lab-robustness");
    robustness.hidden = !view.robustness;
    if (view.robustness) {
      const status = document.getElementById("range-lab-robustness-status");
      status.textContent = view.robustness.robust ? "HISTORICALLY ROBUST · SHOW" : "NOT ROBUST · SHOW";
      status.className = view.robustness.robust ? "is-robust" : "is-failed";
      const totalTrades = view.robustness.costScenarios.length
        ? view.robustness.costScenarios[0].trades
        : 0;
      document.getElementById("range-lab-robustness-warning").textContent = view.robustness.sampleAdequate
        ? `${totalTrades} paired trades · 60-trade overall sample floor met. Direction subgroups still require 30 each.`
        : `${view.robustness.sampleWarning} · Direction subgroups require 30 trades each. Treat every result as low-confidence.`;

      const directionGrid = document.getElementById("range-lab-direction-grid");
      directionGrid.innerHTML = "";
      for (const direction of view.robustness.directions) {
        const card = document.createElement("article");
        card.className = `range-lab-robustness-card ${direction.sampleAdequate ? (direction.positive ? "is-positive" : "is-negative") : "is-low-sample"}`;
        const heading = document.createElement("div");
        const label = document.createElement("strong");
        label.textContent = direction.direction.toUpperCase();
        const sample = document.createElement("span");
        sample.textContent = `${direction.trades} trades${direction.sampleAdequate ? "" : " · LOW SAMPLE"}`;
        heading.append(label, sample);
        const result = document.createElement("small");
        result.textContent = `${direction.expectancy} · PF ${direction.profitFactor}`;
        card.append(heading, result);
        directionGrid.appendChild(card);
      }

      const costGrid = document.getElementById("range-lab-cost-grid");
      costGrid.innerHTML = "";
      for (const scenario of view.robustness.costScenarios) {
        const card = document.createElement("article");
        card.className = `range-lab-robustness-card ${scenario.positive ? "is-positive" : "is-negative"}`;
        const heading = document.createElement("div");
        const label = document.createElement("strong");
        label.textContent = scenario.label.toUpperCase();
        const costs = document.createElement("span");
        costs.textContent = `${scenario.fee} · ${scenario.slippage}`;
        heading.append(label, costs);
        const result = document.createElement("small");
        result.textContent = `${scenario.expectancy} · PF ${scenario.profitFactor} · DD ${scenario.drawdown}`;
        card.append(heading, result);
        costGrid.appendChild(card);
      }

      document.getElementById("range-lab-underwater-trades").textContent =
        `${view.robustness.drawdown.trades} trades`;
      document.getElementById("range-lab-underwater-days").textContent =
        `${view.robustness.drawdown.days} days`;
      document.getElementById("range-lab-underwater-recovered").textContent =
        view.robustness.drawdown.recovered === null
          ? "—"
          : view.robustness.drawdown.recovered ? "Yes" : "No";
      document.getElementById("range-lab-robustness-verdict").textContent = view.robustness.robust
        ? "Passed the frozen historical robustness screen, but this remains already-viewed history—not prospective proof or a trade instruction."
        : "Did not pass the frozen robustness screen. Direction, cost, or regime fragility remains; do not treat a favorable cell as a live edge.";
    }
    const forwardStart = RangeLab.forwardStart(activeRangeLabData);
    document.getElementById("range-lab-paper-note").textContent = forwardStart === "not started"
      ? "Forward paper tracking will begin with the next Range Lab data refresh. It places no orders and does not create a recommendation."
      : `Forward paper record frozen from ${forwardStart}. Each definition is measured separately using only later completed candles; no real orders and no combined portfolio.`;
    drawRangeLabCandidate(candidate);
  }

  function renderRangeLab(data) {
    const panel = document.getElementById("range-lab");
    if (!panel) return;
    if (!data) {
      activeRangeLabData = null;
      activeRangeLabCandidateKey = null;
      clearRangeLabLines();
      panel.hidden = state.asset !== "btc";
      if (state.asset === "btc") {
        const verdict = document.getElementById("range-lab-verdict");
        verdict.className = "range-lab-verdict is-failed";
        verdict.textContent = "RESEARCH DATA UNAVAILABLE";
        document.querySelector("#range-lab-reconciliation strong").textContent =
          "Spot-versus-futures comparison unavailable with the research artifact.";
        document.getElementById("range-lab-options").innerHTML = "";
        document.getElementById("range-lab-detail").hidden = true;
        document.getElementById("range-forward-gate").hidden = true;
        document.getElementById("range-lab-exit-test").hidden = true;
        document.getElementById("range-lab-walk-forward").hidden = true;
        document.getElementById("range-lab-robustness").hidden = true;
      }
      return;
    }
    activeRangeLabData = data;
    maybeSendPaperEventAlerts(data);
    panel.hidden = state.asset !== "btc";
    const freshness = RangeLab.freshness(data);
    const verdict = document.getElementById("range-lab-verdict");
    verdict.className = `range-lab-verdict ${freshness.stale ? "is-stale" : data.holdout_passed ? "is-passed" : "is-failed"}`;
    verdict.textContent = freshness.stale
      ? "RESEARCH DATA STALE"
      : data.holdout_passed ? "HOLDOUT PASSED" : "NO VALIDATED EDGE YET";
    document.getElementById("range-lab-current-label").textContent = freshness.stale
      ? "STALE COMPUTED RANGE"
      : "LAST COMPUTED RANGE";
    document.getElementById("range-lab-warning").textContent =
      `${data.verdict} · Current ranges ${freshness.label}; historical metrics end ${RangeLab.researchCutoff(data)}.`;
    const reconciliation = RangeLab.reconciliationView(data);
    const reconciliationPanel = document.getElementById("range-lab-reconciliation");
    const reconciliationCopy = reconciliationPanel.querySelector("strong");
    reconciliationCopy.textContent = reconciliation
      ? `${reconciliation.overlap} (${reconciliation.start}–${reconciliation.end}) · ${reconciliation.missing} · ${reconciliation.signedCloseBasis} · ${reconciliation.p95OhlcBasis} · ${reconciliation.directionAgreement}. Basis check only—not strategy validation.`
      : "Comparison unavailable until the next Range Lab refresh; futures research and the spot chart are different markets.";
    const options = document.getElementById("range-lab-options");
    options.innerHTML = "";
    for (const candidate of data.candidates) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "range-lab-option";
      button.dataset.rangeKey = candidate.spec.key;
      button.setAttribute("aria-pressed", "false");
      const holdout = candidate.metrics.holdout;
      const paperTrades = candidate.forward_paper && candidate.forward_paper.metrics
        ? candidate.forward_paper.metrics.trades
        : 0;
      const status = candidate.latest_range.active_now ? "active range now" : "not qualified now";
      button.innerHTML = `<strong>${candidate.spec.label}</strong><small>${holdout.trades} holdout · ${paperTrades} forward paper · ${status}</small>`;
      button.addEventListener("click", () => selectRangeLabCandidate(candidate.spec.key));
      options.appendChild(button);
    }
    // Research ranges are opt-in. Do not add extra price lines to the primary
    // chart just because the hidden research panel loaded in the background.
    // Once the user chooses a definition, keep that explicit selection across
    // later data refreshes.
    if (activeRangeLabCandidateKey) selectRangeLabCandidate(activeRangeLabCandidateKey);
    else {
      clearRangeLabLines();
      document.getElementById("range-lab-detail").hidden = true;
    }
  }

  async function pollRangeLab() {
    if (state.asset !== "btc") return;
    try {
      const data = await fetchJson(rangeLabUrl());
      if (state.asset === "btc") renderRangeLab(data);
    } catch (err) {
      console.error("range lab refresh unavailable; keeping the last visible snapshot", err);
    }
  }

  function renderSpyDecision(rangeResearch) {
    setDecisionClass("wait");
    const candidates = rangeResearch && Array.isArray(rangeResearch.candidates)
      ? rangeResearch.candidates
      : [];
    const best = candidates.reduce((current, candidate) => {
      const value = candidate.validation_4bps && candidate.validation_4bps.expectancy_pct;
      const currentValue = current && current.validation_4bps
        ? current.validation_4bps.expectancy_pct
        : -Infinity;
      return Number.isFinite(value) && value > currentValue ? candidate : current;
    }, null);
    const bestValidation = best && best.validation_4bps;
    const bestEightBps = best && best.validation;

    document.getElementById("decision-badge").textContent = "Wait";
    document.getElementById("decision-method").textContent = "Preregistered range-reclaim test · Nov 8, 2026";
    document.getElementById("decision-source-link").hidden = true;
    document.getElementById("decision-title").textContent = "No SPY range-reclaim rule passed validation";
    document.getElementById("decision-summary").textContent =
      "All four rules were frozen before testing. Every one lost money in both training and untouched validation, so no live Call, Put, Buy, or Sell state is enabled.";
    document.getElementById("decision-range").hidden = true;
    document.getElementById("patience-gate").hidden = true;
    document.getElementById("decision-metrics").hidden = false;
    document.getElementById("decision-rr-label").textContent = "Best validation result";
    document.getElementById("decision-support-label").textContent = "Validation sample";
    document.getElementById("decision-resistance-label").textContent = "Promotion gate";

    document.getElementById("decision-rr").textContent = bestValidation
      ? `${bestValidation.expectancy_pct >= 0 ? "+" : ""}${bestValidation.expectancy_pct.toFixed(3)}% / trade`
      : "Unavailable";
    document.getElementById("decision-rr-note").textContent = best
      ? `${best.spec.opening_minutes}-minute range · 4 bps costs`
      : "research artifact unavailable";
    document.getElementById("decision-support-odds").textContent = bestEightBps
      ? `${bestEightBps.trades} trades`
      : "—";
    document.getElementById("decision-support-note").textContent = bestEightBps
      ? `${bestEightBps.longs} long · ${bestEightBps.shorts} short · 8 bps stress`
      : "no validated sample";
    document.getElementById("decision-resistance-odds").textContent = "Blocked";
    document.getElementById("decision-resistance-note").textContent =
      rangeResearch && rangeResearch.selected_key === null
        ? "no rule qualified; locked holdout stayed unopened"
        : "no validated live candidate";
    document.getElementById("decision-caveat").textContent =
      "The chart remains batch context only. Research used Alpaca IEX, one exchange rather than the consolidated U.S. market, and is not a current entry signal.";
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

    if (fullAnalysisIsOpen() && currentPrice !== null && currentPrice !== undefined && proximityCurve) {
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
          // Plain dollar tolerance, not "X% of $81,000" - that phrasing
          // reads as X% of the PRICE (a huge range) when it actually means
          // X% of the round-number step ($1,000 here, so "50%" is +/-$500)
          // - confirmed confusing in practice, not just in theory.
          label: `±$${tolerance.toLocaleString()} of $${nearestRoundPrice.toLocaleString()} — ${tier.hold_rate_pct.toFixed(0)}% held (n=${tier.resolved})`,
          isZone: true,
          isRoundProximity: true,
          opacity,
          showLabel: fraction === 0.02,
        });
      }
    }

    renderOverlays();
  }

  function renderOrderBookWalls(walls) {
    activeOrderBookWalls = walls;
    for (const line of orderBookPriceLines) candleSeries.removePriceLine(line);
    orderBookPriceLines.length = 0;
    wallLinesByKey.clear();
    currentMarkers = currentMarkers.filter((m) => !m.isOrderBookWall);

    if (fullAnalysisIsOpen() && walls) {
      const nearestBid = walls.bids.reduce((nearest, wall) => (
        !nearest || Math.abs(wall.price - lastLivePrice) < Math.abs(nearest.price - lastLivePrice) ? wall : nearest
      ), null);
      const nearestAsk = walls.asks.reduce((nearest, wall) => (
        !nearest || Math.abs(wall.price - lastLivePrice) < Math.abs(nearest.price - lastLivePrice) ? wall : nearest
      ), null);
      for (const wall of [...walls.bids, ...walls.asks]) {
        const wallKey = `wall|${wall.side}|${wall.price}`;
        const isNearest = wall === nearestBid || wall === nearestAsk;
        const wallColor = isNearest ? cssVar("--liquidity") : colorWithAlpha(cssVar("--liquidity"), 0.18);
        const line = candleSeries.createPriceLine({
          price: wall.price,
          color: wallColor,
          lineWidth: isNearest ? 2 : 1,
          lineStyle: LightweightCharts.LineStyle.SparseDotted,
          axisLabelVisible: isNearest,
          title: "",
        });
        orderBookPriceLines.push(line);
        wallLinesByKey.set(wallKey, [line]);

        currentMarkers.push({
          key: wallKey,
          low: wall.price,
          high: wall.price,
          mid: wall.price,
          color: wallColor,
          focusColor: cssVar("--liquidity"),
          label: `${wall.side === "bid" ? "Bid" : "Ask"} wall: ${wall.volume.toFixed(2)} ${state.asset.toUpperCase()} @ ${formatPriceRange(wall.price, wall.price)}`,
          isZone: false,
          isOrderBookWall: true,
          emphasized: isNearest,
          showLabel: isNearest,
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
    btn.textContent = on ? "Cancel picking" : "Pick price on chart";
    hint.hidden = !on;
  }

  const PAPER_RISK_SETTINGS_KEY = "daily-levels-paper-risk-settings";

  function loadPaperRiskSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(PAPER_RISK_SETTINGS_KEY) || "null");
      return saved && typeof saved === "object" ? saved : { riskPct: 1, leverage: 1 };
    } catch (_) {
      return { riskPct: 1, leverage: 1 };
    }
  }

  function savePaperRiskSettings() {
    const accountBalance = parseFloat(document.getElementById("trade-form-account").value);
    const riskPct = parseFloat(document.getElementById("trade-form-risk-pct").value);
    const leverage = parseFloat(document.getElementById("trade-form-leverage").value);
    try {
      localStorage.setItem(PAPER_RISK_SETTINGS_KEY, JSON.stringify({
        accountBalance: Number.isFinite(accountBalance) && accountBalance > 0 ? accountBalance : null,
        riskPct: Number.isFinite(riskPct) && riskPct >= 0.1 && riskPct <= 2 ? riskPct : 1,
        leverage: window.PaperTrader.normalizeLeverage(leverage) || 1,
      }));
    } catch (_) {
      // The position itself already reports storage failures; settings are optional convenience only.
    }
  }

  function currentTradeRiskPlan() {
    if (!pendingTrade) return { valid: false, error: "Choose an entry price first." };
    return window.PaperTrader.riskPlan({
      direction: document.getElementById("trade-form-save").dataset.direction,
      entry: pendingTrade.price,
      stop: parseFloat(document.getElementById("trade-form-stop").value),
      target: parseFloat(document.getElementById("trade-form-target").value),
      accountBalance: parseFloat(document.getElementById("trade-form-account").value),
      riskPct: parseFloat(document.getElementById("trade-form-risk-pct").value),
      leverage: parseFloat(document.getElementById("trade-form-leverage").value),
    });
  }

  function renderDecisionLock(lock) {
    const el = document.getElementById("decision-lock");
    if (!el) return;
    el.className = `decision-lock is-${lock.status}`;
    document.getElementById("decision-lock-status").textContent = `DECISION LOCK · ${lock.passedCount} OF 5 · ${lock.title}`;
    el.querySelector(".decision-lock-heading > span:not(#decision-lock-status)").textContent = `DECISION LOCK · ${lock.passedCount} OF 5`;
    el.querySelector("strong").textContent = lock.title;
    document.getElementById("decision-lock-checks").innerHTML = lock.checks.map((check) => `
      <li class="${check.passed ? "is-passed" : "is-blocked"}">
        <i>${check.passed ? "✓" : "×"}</i>
        <span><b>${escapeHtml(check.label)}</b><small>${escapeHtml(check.detail)}</small></span>
      </li>
    `).join("");
  }

  function updateTradeRiskPreview() {
    const preview = document.getElementById("trade-risk-preview");
    const sizeInput = document.getElementById("trade-form-size");
    const saveBtn = document.getElementById("trade-form-save");
    const plan = currentTradeRiskPlan();
    const fieldsComplete = ["trade-form-account", "trade-form-risk-pct", "trade-form-leverage", "trade-form-stop", "trade-form-target"]
      .every((id) => document.getElementById(id).value !== "") && Boolean(saveBtn.dataset.direction);
    const decisionLock = window.DecisionLock.evaluateCurrent({
      asset: state.asset,
      price: lastLivePrice,
      levels: activeLevels,
      scorecard: activeScorecard,
      strategyRange: activeStrategyRange,
      candles: activeCandles,
      direction: saveBtn.dataset.direction,
      plan,
      minRewardRisk: parseFloat(document.getElementById("trade-form-min-r").value),
      entry: pendingTrade,
      markFresh: liveMarkIsFresh(),
      rangeDecision: RangeDecision,
    });
    renderDecisionLock(decisionLock);
    preview.classList.toggle("is-valid", plan.valid);
    preview.classList.toggle("is-invalid", !plan.valid && fieldsComplete);
    sizeInput.value = plan.valid ? plan.margin.toFixed(2) : "";
    saveBtn.disabled = !plan.valid || !decisionLock.eligible;
    if (!plan.valid) {
      preview.textContent = fieldsComplete ? plan.error : "Choose a side and complete the risk fields to calculate position size.";
      return { ...plan, decisionEligible: decisionLock.eligible };
    }
    preview.innerHTML = `
      <strong>Risk $${plan.riskDollars.toLocaleString(undefined, { maximumFractionDigits: 2 })} · ${plan.rewardRisk.toFixed(2)}R plan</strong>
      <span>$${plan.notional.toLocaleString(undefined, { maximumFractionDigits: 2 })} notional · $${plan.margin.toLocaleString(undefined, { maximumFractionDigits: 2 })} margin at ${plan.leverage}× · stop ${(plan.stopFraction * 100).toFixed(2)}% from entry</span>
      <span>Estimated liquidation: ${plan.liquidation ? formatPriceRange(plan.liquidation, plan.liquidation) : "not applicable at this leverage"}</span>`;
    savePaperRiskSettings();
    return { ...plan, decisionEligible: decisionLock.eligible };
  }

  function openTradeForm() {
    if (!pendingTrade) return;
    const saveBtn = document.getElementById("trade-form-save");
    document.getElementById("trade-form-price").textContent = `Entry: ${formatPriceRange(pendingTrade.price, pendingTrade.price)}`;
    document.getElementById("trade-form-description").value = "";
    const settings = loadPaperRiskSettings();
    document.getElementById("trade-form-account").value = settings.accountBalance || "";
    document.getElementById("trade-form-risk-pct").value = settings.riskPct || 1;
    document.getElementById("trade-form-size").value = "";
    document.getElementById("trade-form-leverage").value = settings.leverage || 1;
    document.getElementById("trade-form-stop").value = "";
    document.getElementById("trade-form-target").value = "";
    document.getElementById("trade-form-min-r").value = "2";
    document.querySelectorAll(".trade-dir-btn").forEach((b) => b.classList.remove("active"));
    saveBtn.disabled = true;
    saveBtn.dataset.direction = "";
    document.getElementById("trade-form").hidden = false;
    updateTradeRiskPreview();
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

      pendingTrade = { time: unixTime, price, source: "chart" };
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
    if (!candles.length) {
      tradeMarkersPlugin.setMarkers([]);
      renderTradeRiskLines(asset);
      return;
    }

    // a trade marked on a wide-history timeframe won't necessarily fall
    // within a narrower timeframe's currently-loaded candles (e.g. a
    // trade from 3 days ago isn't in the 1m view's ~12h window) - skip
    // rather than hand the library a time it has no bar for. Entry and
    // exit are checked independently since a closed trade's two events
    // can straddle that window differently.
    const minTime = candles[0].time;
    const maxTime = candles[candles.length - 1].time;
    const inRange = (t) => t >= minTime && t <= maxTime;

    const markers = [];
    const setup = RangeDecision.confirmedSetup(activeRangeDecision, candles);
    if (setup && inRange(setup.time)) {
      markers.push({
        time: toTimePoint({ time: setup.time }, range),
        position: setup.direction === "long" ? "belowBar" : "aboveBar",
        color: setup.direction === "long" ? cssVar("--support") : cssVar("--resistance"),
        shape: setup.direction === "long" ? "arrowUp" : "arrowDown",
        text: `LIVE ${setup.label}`,
      });
    }
    for (const t of trades) {
      if (inRange(t.time)) {
        markers.push({
          time: toTimePoint({ time: t.time }, range),
          position: t.direction === "long" ? "belowBar" : "aboveBar",
          color: t.direction === "long" ? cssVar("--support") : cssVar("--resistance"),
          shape: t.direction === "long" ? "arrowUp" : "arrowDown",
          text: t.direction === "long" ? "Long" : "Short",
        });
      }
      if (t.exitPrice != null && t.exitTime != null && inRange(t.exitTime)) {
        const pnl = tradePnl(t, null);
        const profitable = pnl ? pnl.usd >= 0 : null;
        const exitLabel = {
          stop: "Stop",
          target: "Target",
          liquidation: "Est. liquidation",
          manual: "Manual exit",
        }[t.exitReason] || "Exit";
        markers.push({
          time: toTimePoint({ time: t.exitTime }, range),
          position: t.direction === "long" ? "aboveBar" : "belowBar",
          color: profitable === null ? cssVar("--accent") : profitable ? cssVar("--support") : cssVar("--resistance"),
          shape: "circle",
          text: exitLabel,
        });
      }
    }
    markers.sort((a, b) => (a.time > b.time ? 1 : a.time < b.time ? -1 : 0));

    tradeMarkersPlugin.setMarkers(markers);
    renderTradeRiskLines(asset);
  }

  function renderTradeRiskLines(asset) {
    if (!candleSeries) return;
    const trade = asset === "spy"
      ? null
      : loadTrades(asset).filter((item) => item.exitPrice == null).sort((a, b) => b.time - a.time)[0] || null;
    const liquidation = trade ? estimatedLiquidationPrice(trade) : null;
    const signature = trade
      ? [asset, trade.id, trade.price, trade.stopPrice, trade.targetPrice, liquidation].join(":")
      : `${asset}:none`;
    if (signature === tradeRiskLineSignature) return;
    for (const line of tradeRiskPriceLines) candleSeries.removePriceLine(line);
    tradeRiskPriceLines.length = 0;
    tradeRiskLineSignature = signature;
    if (!trade) return;

    const add = (price, title, color, style, width = 2) => {
      if (!Number.isFinite(price)) return;
      tradeRiskPriceLines.push(candleSeries.createPriceLine({
        price,
        title,
        color,
        lineWidth: width,
        lineStyle: style,
        lineVisible: true,
        axisLabelVisible: true,
      }));
    };
    add(trade.price, "PAPER ENTRY", cssVar("--accent"), LightweightCharts.LineStyle.Solid, 2);
    add(trade.stopPrice, "PAPER STOP", cssVar("--resistance"), LightweightCharts.LineStyle.Dashed, 2);
    add(trade.targetPrice, "PAPER TARGET", cssVar("--support"), LightweightCharts.LineStyle.Dashed, 2);
    add(liquidation, "EST. LIQ.", cssVar("--flip"), LightweightCharts.LineStyle.Dotted, 1);
  }

  function startDeletingTrade(id) {
    deletingTradeId = id;
    renderTradesTable(state.asset, lastLivePrice);
  }

  function cancelDeletingTrade() {
    deletingTradeId = null;
    renderTradesTable(state.asset, lastLivePrice);
  }

  function confirmDeleteTrade(asset, id) {
    saveTrades(asset, loadTrades(asset).filter((t) => t.id !== id));
    deletingTradeId = null;
    renderTradeMarkers(state.asset, state.range, activeCandles);
    renderTradesTable(asset, lastLivePrice);
  }

  // Mirrors the real formula: margin (size) x leverage = notional
  // position, so a % move in price becomes a leveraged % move on the
  // margin actually put up - the standard retail-perp mental model, same
  // one the liquidation estimate's own math (entry * (1 +/- 1/leverage))
  // is built on. An open trade's reference price is the live price (so
  // this moves with the streamed price); a closed one's is frozen at its own
  // exitPrice forever, regardless of what currentPrice is passed in -
  // that's what "closed" means.
  function tradePnl(trade, currentPrice) {
    return window.PaperTrader.pnl(trade, currentPrice);
  }

  function tradePnlDisplay(trade, currentPrice) {
    const pnl = tradePnl(trade, currentPrice);
    if (!pnl) return { text: "—", color: "var(--text-muted)" };
    const sign = pnl.usd >= 0 ? "+" : "";
    const suffix = pnl.isLiquidated
      ? " (est. liquidated)"
      : pnl.isRealized
        ? ""
        : liveMarkIsFresh()
          ? " (live)"
          : " (last mark)";
    return {
      text: `${sign}$${pnl.usd.toLocaleString(undefined, { maximumFractionDigits: 2 })} (${sign}${pnl.pct.toFixed(1)}%)${suffix}`,
      color: pnl.usd >= 0 ? "var(--support)" : "var(--resistance)",
    };
  }

  function settleTriggeredTrades(asset, currentPrice) {
    if (asset === "spy" || !Number.isFinite(currentPrice)) return false;
    const result = window.PaperTrader.settleTrades(loadTrades(asset), currentPrice);
    if (result.changed) saveTrades(asset, result.trades);
    return result.changed;
  }

  function estimatedLiquidationPrice(trade) {
    return window.PaperTrader.estimatedLiquidationPrice(trade);
  }

  function renderPaperPositions(asset, currentPrice) {
    const container = document.getElementById("paper-position-summary");
    if (!container) return;
    if (asset === "spy") {
      container.innerHTML = '<div class="paper-position-empty">Live SPY paper tracking is paused because this page only has batch SPY data. BTC and ETH use a real-time Kraken stream.</div>';
      return;
    }

    const openTrades = loadTrades(asset)
      .filter((trade) => trade.exitPrice == null)
      .sort((a, b) => b.time - a.time);
    if (!openTrades.length) {
      container.innerHTML = `<div class="paper-position-empty">No open ${asset.toUpperCase()} paper position. Use the live price, tap a chart price, or enter one manually.</div>`;
      return;
    }

    container.innerHTML = openTrades.map((trade) => {
      const pnl = tradePnlDisplay(trade, currentPrice);
      const direction = trade.direction === "short" ? "short" : "long";
      const leverage = window.PaperTrader.normalizeLeverage(trade.leverage);
      const notional = trade.size && leverage ? trade.size * leverage : null;
      const liquidation = estimatedLiquidationPrice(trade);
      const currentR = window.PaperTrader.rMultiple(trade, currentPrice);
      const liveMark = Number.isFinite(currentPrice) ? formatPriceRange(currentPrice, currentPrice) : "Connecting…";
      return `
        <article class="paper-position-card">
          <div class="paper-position-card-head">
            <span class="paper-position-side ${direction}">${direction} · ${leverage ? `${leverage}×` : "no leverage"}</span>
            <strong class="paper-position-pnl" style="color: ${pnl.color}">${pnl.text}</strong>
          </div>
          <div class="paper-position-card-metrics">
            <span>ENTRY<strong>${formatPriceRange(trade.price, trade.price)}</strong></span>
            <span>LIVE MARK<strong>${liveMark}</strong></span>
            <span>STOP<strong>${Number.isFinite(trade.stopPrice) ? formatPriceRange(trade.stopPrice, trade.stopPrice) : "—"}</strong></span>
            <span>TARGET<strong>${Number.isFinite(trade.targetPrice) ? formatPriceRange(trade.targetPrice, trade.targetPrice) : "—"}</strong></span>
            <span>R NOW<strong>${currentR == null ? "—" : `${currentR >= 0 ? "+" : ""}${currentR.toFixed(2)}R`}</strong></span>
            <span>PLAN<strong>${Number.isFinite(trade.rewardRisk) ? `${trade.rewardRisk.toFixed(2)}R` : "—"}</strong></span>
            <span>RISK<strong>${Number.isFinite(trade.riskDollars) ? `$${trade.riskDollars.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—"}</strong></span>
            <span>NOTIONAL<strong>${notional ? `$${notional.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—"}</strong></span>
            <span>EST. LIQ.<strong>${liquidation ? formatPriceRange(liquidation, liquidation) : "—"}</strong></span>
          </div>
        </article>`;
    }).join("");
  }

  function updateLiveTradePnlCells(asset, currentPrice) {
    if (state.asset !== asset) return;
    const tradesById = new Map(loadTrades(asset).map((trade) => [String(trade.id), trade]));
    document.querySelectorAll(".trade-pnl-cell[data-trade-id]").forEach((cell) => {
      const trade = tradesById.get(cell.dataset.tradeId);
      if (!trade) return;
      const display = tradePnlDisplay(trade, currentPrice);
      cell.textContent = display.text;
      cell.style.color = display.color;
    });
    document.querySelectorAll(".trade-r-cell[data-trade-id]").forEach((cell) => {
      const trade = tradesById.get(cell.dataset.tradeId);
      if (!trade) return;
      const r = window.PaperTrader.rMultiple(trade, currentPrice);
      cell.textContent = r == null ? "—" : `${r >= 0 ? "+" : ""}${r.toFixed(2)}R`;
      cell.style.color = r == null ? "var(--text-muted)" : r >= 0 ? "var(--support)" : "var(--resistance)";
    });
    renderPaperPositions(asset, currentPrice);
  }

  function startClosingTrade(id) {
    closingTradeId = id;
    renderTradesTable(state.asset, lastLivePrice);
  }

  function cancelClosingTrade() {
    closingTradeId = null;
    renderTradesTable(state.asset, lastLivePrice);
  }

  function confirmCloseTrade(asset, id, exitPrice) {
    if (!Number.isFinite(exitPrice) || exitPrice <= 0) return;
    const trades = loadTrades(asset);
    const trade = trades.find((t) => t.id === id);
    if (!trade) return;
    trade.exitPrice = exitPrice;
    trade.exitTime = Math.floor(Date.now() / 1000);
    trade.exitReason = "manual";
    saveTrades(asset, trades);
    closingTradeId = null;
    renderTradeMarkers(state.asset, state.range, activeCandles);
    renderTradesTable(asset, lastLivePrice);
  }

  function renderTradesTable(asset, currentPrice) {
    const tbody = document.getElementById("trades-table-body");
    tbody.innerHTML = "";

    const trades = [...loadTrades(asset)].sort((a, b) => b.time - a.time);
    renderPaperPositions(asset, currentPrice);
    if (!trades.length) {
      tbody.innerHTML = `<tr><td colspan="12">No trades marked yet for ${asset.toUpperCase()}.</td></tr>`;
      return;
    }

    for (const trade of trades) {
      const tr = document.createElement("tr");
      const dateText = new Date(trade.time * 1000).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
      const directionColor = trade.direction === "long" ? "var(--support)" : "var(--resistance)";
      const exitReason = {
        stop: "stop",
        target: "target",
        liquidation: "est. liquidation",
        manual: "manual",
      }[trade.exitReason] || "";
      const exitText = trade.exitPrice != null
        ? `${formatPriceRange(trade.exitPrice, trade.exitPrice)}${exitReason ? ` · ${exitReason}` : ""}`
        : "—";
      const sizeText = trade.size ? `$${trade.size.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—";
      const leverageText = trade.leverage ? `${trade.leverage}x` : "—";
      const stopText = Number.isFinite(trade.stopPrice) ? formatPriceRange(trade.stopPrice, trade.stopPrice) : "—";
      const targetText = Number.isFinite(trade.targetPrice) ? formatPriceRange(trade.targetPrice, trade.targetPrice) : "—";
      const r = window.PaperTrader.rMultiple(trade, currentPrice);
      const rText = r == null ? "—" : `${r >= 0 ? "+" : ""}${r.toFixed(2)}R`;

      const pnlDisplay = tradePnlDisplay(trade, currentPrice);

      tr.innerHTML = `
        <td>${dateText}</td>
        <td class="type-cell" style="color: ${directionColor}">${trade.direction}</td>
        <td>${formatPriceRange(trade.price, trade.price)}</td>
        <td>${exitText}</td>
        <td>${sizeText}</td>
        <td>${leverageText}</td>
        <td>${stopText}</td>
        <td>${targetText}</td>
        <td class="trade-r-cell" data-trade-id="${escapeHtml(String(trade.id))}" style="color: ${r == null ? "var(--text-muted)" : r >= 0 ? "var(--support)" : "var(--resistance)"}">${rText}</td>
        <td class="trade-pnl-cell" data-trade-id="${escapeHtml(String(trade.id))}" style="color: ${pnlDisplay.color}">${pnlDisplay.text}</td>
        <td class="trade-note-cell">${trade.description ? escapeHtml(trade.description) : "—"}</td>
        <td></td>
      `;
      const actionsCell = tr.lastElementChild;

      if (closingTradeId === trade.id) {
        actionsCell.className = "trade-close-cell";
        const input = document.createElement("input");
        input.type = "number";
        input.step = "any";
        input.inputMode = "decimal";
        input.placeholder = "Exit price";
        input.className = "trade-close-input";
        if (Number.isFinite(currentPrice)) input.value = currentPrice;
        const confirmBtn = document.createElement("button");
        confirmBtn.className = "trade-close-confirm-btn";
        confirmBtn.textContent = "Confirm";
        const doConfirm = () => confirmCloseTrade(asset, trade.id, parseFloat(input.value));
        confirmBtn.addEventListener("click", doConfirm);
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") doConfirm();
        });
        const cancelBtn = document.createElement("button");
        cancelBtn.className = "trade-close-cancel-btn";
        cancelBtn.textContent = "Cancel";
        cancelBtn.addEventListener("click", cancelClosingTrade);
        actionsCell.append(input, confirmBtn, cancelBtn);
      } else if (deletingTradeId === trade.id) {
        actionsCell.className = "trade-close-cell";
        const confirmDeleteBtn = document.createElement("button");
        confirmDeleteBtn.className = "trade-close-confirm-btn trade-delete-confirm-btn";
        confirmDeleteBtn.textContent = "Confirm delete";
        confirmDeleteBtn.addEventListener("click", () => confirmDeleteTrade(asset, trade.id));
        const cancelDeleteBtn = document.createElement("button");
        cancelDeleteBtn.className = "trade-close-cancel-btn";
        cancelDeleteBtn.textContent = "Cancel";
        cancelDeleteBtn.addEventListener("click", cancelDeletingTrade);
        actionsCell.append(confirmDeleteBtn, cancelDeleteBtn);
      } else {
        if (trade.exitPrice == null) {
          const closeBtn = document.createElement("button");
          closeBtn.className = "trade-close-btn";
          closeBtn.textContent = "Close at mark";
          closeBtn.addEventListener("click", () => startClosingTrade(trade.id));
          actionsCell.appendChild(closeBtn);
        }
        const deleteBtn = document.createElement("button");
        deleteBtn.className = "trade-delete-btn";
        deleteBtn.textContent = "Delete";
        // Deleting is permanent (localStorage only, no undo/trash) - this
        // is a confirm step, not an instant delete, same inline-row pattern
        // startClosingTrade()/cancelClosingTrade() already use for closing.
        deleteBtn.addEventListener("click", () => startDeletingTrade(trade.id));
        actionsCell.appendChild(deleteBtn);
      }
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
    pendingTrade = { time: Math.floor(Date.now() / 1000), price, source: "manual" };
    input.value = "";
    openTradeForm();
  }

  function useLiveTradePrice() {
    if (!liveMarkIsFresh()) return;
    setMarkingMode(false);
    pendingTrade = { time: Math.floor(Date.now() / 1000), price: lastLivePrice, source: "live" };
    openTradeForm();
  }

  function wireTradeForm() {
    document.getElementById("trade-live-btn").addEventListener("click", useLiveTradePrice);
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
        updateTradeRiskPreview();
      });
    });

    document.getElementById("trade-form-cancel").addEventListener("click", closeTradeForm);

    const leverageInput = document.getElementById("trade-form-leverage");
    for (const id of ["trade-form-account", "trade-form-risk-pct", "trade-form-leverage", "trade-form-stop", "trade-form-target", "trade-form-min-r"]) {
      document.getElementById(id).addEventListener("input", () => {
        leverageInput.setCustomValidity("");
        updateTradeRiskPreview();
      });
    }

    document.getElementById("trade-form-save").addEventListener("click", (e) => {
      const direction = e.currentTarget.dataset.direction;
      if (!pendingTrade || !direction) return;

      const plan = updateTradeRiskPreview();
      if (!plan.valid || !plan.decisionEligible) return;

      const trades = loadTrades(state.asset);
      trades.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        time: pendingTrade.time,
        price: pendingTrade.price,
        direction,
        size: plan.margin,
        leverage: plan.leverage,
        accountBalance: plan.accountBalance,
        riskPct: plan.riskPct,
        riskDollars: plan.riskDollars,
        notional: plan.notional,
        stopPrice: plan.stop,
        targetPrice: plan.target,
        rewardRisk: plan.rewardRisk,
        description: document.getElementById("trade-form-description").value.trim(),
        createdAt: new Date().toISOString(),
      });
      saveTrades(state.asset, trades);

      closeTradeForm();
      renderTradeMarkers(state.asset, state.range, activeCandles);
      renderTradesTable(state.asset, lastLivePrice);
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

  function renderLevelJumpSelect(levels, currentPrice, { preserveInteraction = false } = {}) {
    const select = document.getElementById("level-jump-select");
    if (!select) return;
    // Rebuilding a native select while it is open can close it or move its
    // keyboard focus. Stream ticks may refresh the live percentages only
    // between interactions; the first tick after blur catches it back up.
    if (preserveInteraction && (document.activeElement === select || select.matches(":active"))) return;
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

  function renderHeader(levelsData, currentPrice = levelsData.price) {
    const generated = new Date(levelsData.generated_at_utc);
    const formatted = new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "America/Chicago",
    }).format(generated);

    document.getElementById("generated-label").textContent = `Levels calculated ${formatted} CT`;
    document.getElementById("price-label").textContent = currentPrice.toLocaleString(undefined, {
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

  function renderStructuralReclaimProof(regime) {
    const el = document.getElementById("structural-reclaim-proof");
    if (!el) return;
    const boundary = regime && regime.boundary;
    if (!RangeDecision.structuralRegimeIsUsable(regime)) {
      el.innerHTML = "<strong>Structural reclaim:</strong> calculated evidence unavailable; the dated creator-sourced fallback remains visible.";
      return;
    }
    const acceptance = regime.acceptance && regime.acceptance.state
      ? regime.acceptance.state.replaceAll("-", " ")
      : "not classified";
    const calculated = regime.calculated_at_utc
      ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "America/Chicago" }).format(new Date(regime.calculated_at_utc))
      : "unknown date";
    const tests = boundary.tests.map((test) => `
      <li><time datetime="${escapeHtml(test.date)}">${escapeHtml(test.date)}</time><b>$${Number(test.high).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b></li>
    `).join("");
    const closes = regime.acceptance.closes.map((close) => `
      <li><time datetime="${escapeHtml(close.date)}">${escapeHtml(close.date)}</time><b>$${Number(close.close).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b></li>
    `).join("");
    el.innerHTML = `
      <div class="structural-proof-heading">
        <div><small>WHY THIS LEVEL?</small><strong>$${Number(boundary.exact_price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></div>
        <span>${escapeHtml(regime.quality)} · ${escapeHtml(acceptance)}</span>
      </div>
      <p>The ${boundary.origin_date} Daily high became the exact boundary because its pivot cluster won the frozen ranking: most tests, then distinct months, duration, and recency.</p>
      <div class="structural-proof-grid">
        <section><small>CONFIRMING PIVOTS</small><ul>${tests}</ul></section>
        <section><small>LATEST COMPLETED CLOSES</small><ul>${closes}</ul></section>
      </div>
      <p class="structural-audit-status" id="structural-audit-status">Loading boundary history…</p>
      <p class="structural-proof-method">Last retest ${boundary.last_test_date} · calculated ${calculated} · <span>${escapeHtml(regime.method_version)}</span></p>
      <p class="structural-proof-caveat">This is calculated structure, not a prediction or entry signal, and not a guarantee.</p>
    `;
  }

  function renderStructuralReclaimAudit(audit) {
    const el = document.getElementById("structural-audit-status");
    if (!el) return;
    if (!audit || audit.status === "unavailable") {
      el.textContent = "Boundary history unavailable. No change alert can be issued.";
      return;
    }
    const since = audit.current_since
      ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "America/Chicago" }).format(new Date(audit.current_since))
      : "an unknown date";
    if (audit.status === "changed" && audit.latest_change) {
      el.innerHTML = `<strong>Changed ${since}:</strong> $${Number(audit.latest_change.old_exact_price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} → $${Number(audit.latest_change.new_exact_price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}. ${escapeHtml(audit.latest_change.reason)}`;
      return;
    }
    el.innerHTML = `<strong>${audit.status === "initialized" ? "First recorded" : "Unchanged"} since ${since}.</strong> ${escapeHtml(audit.reason || "The same established pivot cluster remains selected.")}`;
  }

  function maybeSendStructuralReclaimAlert(audit) {
    const notice = audit && audit.notification;
    if (!patienceAlertsEnabled || !notice || !notice.should_notify || !notice.fingerprint) return;
    const fingerprint = `structural-reclaim:${notice.fingerprint}`;
    if (alertedFingerprints().includes(fingerprint)) return;
    rememberAlertFingerprint(fingerprint);
    showAlertToast("BTC · ESTABLISHED BOUNDARY CHANGE", notice.title, notice.detail);
    if (document.hidden && patienceAlertPermission() === "granted") {
      try {
        const notification = new Notification(notice.title, {
          body: notice.detail,
          tag: "range-desk-btc-structural-reclaim",
          renotify: false,
        });
        notification.onclick = () => {
          window.focus();
          notification.close();
        };
      } catch (err) {
        console.error("boundary-change notification unavailable; in-page alert still shown", err);
      }
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

  // --- exhaustion pattern banner ---
  //
  // Purely descriptive, like everything else on this site - reports that a
  // Heikin-Ashi exhaustion candle just formed on the Daily timeframe and
  // what that pattern has historically done, never a call to go long/short.
  // Computed once a day in the same engine run as every other level
  // (src/levels/exhaustion_pattern.py via src/levels/engine.py), not polled
  // live - same cadence as POC/VAH/VAL/golden pocket, not the real-time
  // price/order-book path.

  function renderExhaustionBanner(detected, scorecardEntry) {
    const el = document.getElementById("exhaustion-banner");
    if (!detected) {
      el.hidden = true;
      return;
    }
    el.hidden = false;

    const isBullish = detected.direction === "bullish_reversal";
    el.className = `exhaustion-banner ${isBullish ? "exhaustion-bullish" : "exhaustion-bearish"}`;

    const label = isBullish ? "Bullish exhaustion" : "Bearish exhaustion";
    const arrow = isBullish ? "▲" : "▼";

    let oddsText = "no historical read yet";
    if (scorecardEntry && scorecardEntry.resolved > 0) {
      const lowConfNote = scorecardEntry.low_confidence ? " (low confidence, small sample)" : "";
      oddsText = `reversed within 10 days ${scorecardEntry.hold_rate_pct.toFixed(1)}% of the time historically (n=${scorecardEntry.resolved})${lowConfNote}`;
    }

    el.innerHTML = `
      <span class="exhaustion-banner-label">${arrow} ${label} pattern on Daily (${detected.date})</span>
      <span class="exhaustion-banner-odds">${oddsText} — not a signal, read the odds yourself</span>
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

  // --- SPY (exhaustion-reversal backtest) ---
  //
  // A fundamentally different product than BTC/ETH: not a level map, a
  // mechanical backtest of a user-defined intraday options setup. Yahoo's
  // chart API sends no CORS header (confirmed live against
  // query1.finance.yahoo.com directly) so unlike crypto this can't be
  // polled from the browser - the chart, signal markers and backtest table
  // are all baked once per cron run into static JSON, same staleness as
  // the rest of this static site, no live ticking.

  let activeSpyChart = null; // cached spy_chart.json - switching HA timeframe re-renders from this, no refetch
  let activeSpyTrades = [];

  function spyChartUrl() {
    return "data/spy_chart.json";
  }
  function spySignalsUrl() {
    return "data/spy_signals.json";
  }
  function spyBacktestUrl() {
    return "data/spy_backtest.json";
  }
  function spyRangeResearchUrl() {
    return "data/spy_range_reclaim.json";
  }

  function applyAssetVisibility(asset) {
    const isSpy = asset === "spy";
    const paperTrader = document.getElementById("paper-trader");
    const paperStatus = document.getElementById("paper-trader-status");
    const paperLiveLabel = document.getElementById("paper-trader-live-label");
    document.getElementById("subtitle").textContent = isSpy
      ? "SPY range research with a fail-closed validation gate."
      : asset === "btc"
        ? "Live BTC price, the current macro range, and a clear confirmation checklist."
        : "Live ETH price, the current rolling range, and a clear confirmation checklist.";

    document.getElementById("range-select").hidden = isSpy;
    document.getElementById("spy-timeframe-select").hidden = !isSpy;
    document.getElementById("futures-context").hidden = isSpy; // crypto path's own renderFuturesContext() corrects this right after, for btc/eth
    document.getElementById("exhaustion-banner").hidden = true; // crypto path's own renderExhaustionBanner() corrects this right after, for btc/eth
    document.getElementById("nearest-levels").hidden = isSpy;
    document.getElementById("level-jump-wrap").hidden = isSpy;
    document.getElementById("nearby-context").hidden = isSpy;
    document.getElementById("trade-controls").hidden = isSpy;
    document.getElementById("chart-legend").hidden = isSpy;
    document.getElementById("spy-legend").hidden = !isSpy;
    document.getElementById("liquidation-note").hidden = isSpy;
    document.getElementById("spy-chart-note").hidden = !isSpy;
    document.getElementById("trades-section").hidden = isSpy;
    document.getElementById("level-table-section").hidden = isSpy;
    document.getElementById("scorecard-section").hidden = isSpy;
    document.getElementById("spy-backtest-section").hidden = !isSpy;
    document.getElementById("spy-signals-section").hidden = !isSpy;
    document.getElementById("crypto-explainer").hidden = isSpy;
    document.getElementById("range-method-sources").hidden = asset !== "btc";
    document.getElementById("spy-explainer").hidden = !isSpy;
    document.getElementById("chart-live-ticker").hidden = isSpy;
    document.getElementById("range-lab").hidden = asset !== "btc";
    syncAssetGuidance(asset);
    paperTrader.classList.toggle("is-unavailable", isSpy);
    paperStatus.textContent = isSpy
      ? "SPY is batch data on this site, so live paper P&L is disabled rather than presenting a stale mark as real-time."
      : `${asset.toUpperCase()} P&L follows Kraken's real-time trade stream. No order is sent anywhere.`;
    paperLiveLabel.textContent = isSpy ? "Batch data" : "Live price";
    if (isSpy) {
      closeTradeForm();
      // Clear crypto paper entry/stop/target/liquidation lines immediately,
      // before the asynchronous SPY batch request finishes.
      renderTradeRiskLines("spy");
    }
    renderPaperPositions(asset, isSpy ? null : lastLivePrice);
    if (asset !== "btc") clearRangeLabLines();
    if (isSpy) document.getElementById("live-badge").hidden = true;
  }

  function syncAssetGuidance(asset) {
    const isSpy = asset === "spy";
    const guide = document.getElementById("quick-guide");
    const decisionJump = document.getElementById("mobile-jump-decision");
    const thirdJump = document.getElementById("mobile-jump-third");
    if (guide) {
      guide.hidden = isSpy;
      if (isSpy) guide.open = false;
    }
    if (decisionJump) decisionJump.textContent = isSpy ? "Summary" : "Checklist";
    if (thirdJump) {
      thirdJump.textContent = isSpy ? "Research" : "Paper trade";
      thirdJump.dataset.jumpTarget = isSpy ? "advanced-analysis" : "paper-trader";
    }
  }

  function organizeAdvancedAnalysis() {
    const destination = document.getElementById("advanced-analysis-content");
    if (!destination) return;
    const advancedIds = [
      "range-open-forward",
      "range-lab",
      "nearby-context",
      "futures-context",
      "exhaustion-banner",
      "chart-legend",
      "spy-legend",
      "liquidation-note",
      "spy-chart-note",
      "level-table-section",
      "scorecard-section",
      "spy-backtest-section",
      "spy-signals-section",
      "crypto-explainer",
      "spy-explainer",
    ];
    for (const id of advancedIds) {
      const element = document.getElementById(id);
      if (element) destination.appendChild(element);
    }
  }

  function organizePrimaryLayout() {
    const main = document.querySelector("main");
    if (!main) return;
    const primary = [
      document.querySelector(".controls"),
      document.getElementById("market-clock"),
      document.querySelector(".meta-row"),
      document.getElementById("chart-container"),
      document.getElementById("decision-brief"),
      document.getElementById("quick-guide"),
      document.getElementById("paper-trader"),
      document.getElementById("advanced-analysis"),
    ];
    for (const element of primary) {
      if (element) main.appendChild(element);
    }
  }

  function wireMobileJumpNav() {
    document.querySelectorAll(".mobile-jump-nav [data-jump-target]").forEach((button) => {
      button.addEventListener("click", () => {
        const target = document.getElementById(button.dataset.jumpTarget);
        if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  }

  function wireAdvancedAnalysis() {
    const details = document.getElementById("advanced-analysis");
    if (!details) return;
    const sourceLink = document.getElementById("decision-source-link");
    if (sourceLink) {
      sourceLink.addEventListener("click", () => {
        // The source summary lives in the intentionally collapsed analysis
        // panel. Open it before the hash navigation runs so the linked
        // evidence is visible rather than hidden inside a closed <details>.
        details.open = true;
      });
    }
    details.addEventListener("toggle", () => {
      clearPriceSnapState();
      if (!details.open) {
        // Research overlays are intentionally scoped to the expanded drawer.
        // Keep the selected definition for comparison, but restore the quiet
        // primary chart as soon as the drawer closes.
        clearRangeLabLines();
      } else if (activeRangeLabCandidateKey && activeRangeLabData) {
        const candidate = RangeLab.candidateByKey(activeRangeLabData, activeRangeLabCandidateKey);
        if (candidate) drawRangeLabCandidate(candidate);
      }
      if (state.asset !== "spy") {
        renderLevels(activeLevels);
        renderRoundProximityBands(lastLivePrice, activeProximity);
        renderOrderBookWalls(activeOrderBookWalls);
      }
      renderOverlays();
    });
  }

  function wireNearbyContext() {
    const details = document.getElementById("nearby-context");
    if (!details) return;
    details.addEventListener("toggle", () => {
      if (state.asset !== "spy") renderLevels(activeLevels);
      renderOverlays();
    });
  }

  function renderSpyChart(bars) {
    ensureChart();
    clearPriceSnapState();
    updateChartFocusStatus();
    // SPY has no levels/heatmap of its own - strip any leftover crypto
    // price lines/labels/liquidation rows rather than leaving them drawn
    // over a chart they no longer describe.
    clearPriceLines();
    clearOverlays();
    // Reassert the clean SPY chart on initial load, refresh, and every
    // Heikin-Ashi timeframe change. This is intentionally separate from
    // the crypto trade-marker path.
    renderTradeRiskLines("spy");
    activeRangeDecision = null;
    activeLiquidationBins = [];
    // Order book walls are drawn separately from activePriceLines (they
    // redraw on every live market update, not just on load) and SPY has no live
    // poll to naturally refresh/clear them - without this a BTC/ETH wall
    // line stays drawn on the price axis after switching to SPY.
    for (const line of orderBookPriceLines) candleSeries.removePriceLine(line);
    orderBookPriceLines.length = 0;

    const candleData = bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }));
    candleSeries.setData(candleData);
    volumeSeries.setData([]); // no HA volume computed - an empty histogram beats a stale crypto one
    // Historical Call/Put annotations are intentionally excluded from the
    // decision chart. They were batch backtest observations with outcomes
    // known later, not live information available to the viewer.
    if (tradeMarkersPlugin) tradeMarkersPlugin.setMarkers([]);
    candleSeries.priceScale().applyOptions({ mode: LightweightCharts.PriceScaleMode.Normal });
    chart.timeScale().fitContent();
    lastLiveUnixTime = bars.length ? bars[bars.length - 1].time : null;
  }

  function rerenderSpyTimeframe() {
    if (!activeSpyChart) return;
    const bars = activeSpyChart.timeframes[state.spyTimeframe] || [];
    renderSpyChart(bars);
  }

  function renderSpyBacktestTable(backtest) {
    const tbody = document.getElementById("spy-backtest-table-body");
    tbody.innerHTML = "";
    if (!backtest || !backtest.by_min_confirmed) {
      tbody.innerHTML = `<tr><td colspan="6">Backtest not available yet.</td></tr>`;
      return;
    }
    for (const n of ["1", "2", "3", "4"]) {
      const s = backtest.by_min_confirmed[n];
      const tr = document.createElement("tr");
      if (!s || !s.resolved) {
        tr.innerHTML = `<td>${n}+</td><td>${s ? s.trades : 0}</td><td>0</td><td>—</td><td>—</td><td>—</td>`;
      } else {
        const ret = s.avg_pct_return;
        const retColor = ret >= 0 ? "var(--support)" : "var(--resistance)";
        tr.innerHTML = `
          <td>${n}+</td>
          <td>${s.trades}</td>
          <td>${s.resolved}</td>
          <td>${s.target_hit_rate_pct.toFixed(1)}%</td>
          <td>${s.stop_hit_rate_pct.toFixed(1)}%</td>
          <td style="color: ${retColor}">${ret >= 0 ? "+" : ""}${ret.toFixed(2)}%</td>
        `;
      }
      tbody.appendChild(tr);
    }
  }

  function renderSpySignalsTable(trades) {
    const tbody = document.getElementById("spy-signals-table-body");
    tbody.innerHTML = "";
    if (!trades.length) {
      tbody.innerHTML = `<tr><td colspan="7">No signals detected in the last 60 days.</td></tr>`;
      return;
    }
    const outcomeText = { target: "Target hit", stop: "Stopped out", expiry: "Expired", incomplete: "Incomplete (data horizon)" };
    const dateFmt = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" });
    const sorted = [...trades].sort((a, b) => b.signal_time - a.signal_time);
    for (const t of sorted) {
      const tr = document.createElement("tr");
      const dirColor = t.direction === "call" ? "var(--support)" : "var(--resistance)";
      const retText = t.pct_return === null || t.pct_return === undefined ? "—" : `${t.pct_return >= 0 ? "+" : ""}${(t.pct_return * 100).toFixed(1)}%`;
      const retColor = t.pct_return === null || t.pct_return === undefined ? "var(--text-muted)" : t.pct_return >= 0 ? "var(--support)" : "var(--resistance)";
      tr.innerHTML = `
        <td>${dateFmt.format(new Date(t.signal_time * 1000))} ET</td>
        <td style="color: ${dirColor}">${t.direction === "call" ? "Call" : "Put"}</td>
        <td>${t.confirmed_timeframes.join(", ")}m</td>
        <td>${t.entry_underlying.toFixed(2)}</td>
        <td>${t.strike.toFixed(0)}</td>
        <td>${outcomeText[t.exit_reason] || t.exit_reason}</td>
        <td style="color: ${retColor}">${retText}</td>
      `;
      tbody.appendChild(tr);
    }
  }

  async function loadAndRenderSpy() {
    try {
      const [chartData, signalsData, backtestData, rangeResearch] = await Promise.all([
        fetchJson(spyChartUrl()),
        fetchJson(spySignalsUrl()),
        fetchJson(spyBacktestUrl()),
        fetchJson(spyRangeResearchUrl()),
      ]);
      if (state.asset !== "spy") return; // user moved on while this was in flight

      activeSpyChart = chartData;
      activeSpyTrades = signalsData.trades || [];

      renderHeader(chartData); // same {generated_at_utc, price} shape renderHeader already expects

      const bars = chartData.timeframes[state.spyTimeframe] || [];
      renderSpyChart(bars);
      renderSpyBacktestTable(backtestData);
      renderSpySignalsTable(activeSpyTrades);
      renderSpyDecision(rangeResearch);
    } catch (err) {
      if (state.asset !== "spy") return;
      console.error(err);
      renderDecisionUnavailable("SPY chart or backtest data is currently unavailable.");
      const banner = document.getElementById("stale-banner");
      banner.hidden = false;
      banner.textContent = "Could not load SPY data — either the daily workflow hasn't run yet, or Yahoo's API is unreachable right now.";
    }
  }

  // --- toggles ---

  function setActiveButtons() {
    document.querySelectorAll("#asset-toggle .toggle-btn").forEach((btn) => {
      const isActive = btn.dataset.asset === state.asset;
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-pressed", String(isActive));
    });
    document.getElementById("range-select").value = state.range;
    document.getElementById("spy-timeframe-select").value = state.spyTimeframe;
    applyAssetVisibility(state.asset);
    if (window.MarketSessions) MarketSessions.setAsset(state.asset);
  }

  function wireToggles() {
    document.querySelectorAll("#asset-toggle .toggle-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.asset = btn.dataset.asset;
        previousLivePrice = null;
        lastLivePrice = null;
        lastLiveTickAt = null;
        activeRangeDecision = null;
        setActiveButtons();
        renderChartLiveTicker("reconnecting");
        writeHash();
        // a pending trade's price/time belong to whatever asset was
        // active when the chart was clicked - switching assets mid-entry
        // would otherwise save it against the wrong one.
        setMarkingMode(false);
        closeTradeForm();
        // Same reasoning for an in-progress close/delete confirmation - a
        // trade id from the asset being left shouldn't silently reopen its
        // inline form against whatever trade happens to share that id in
        // the new asset's own trade list.
        closingTradeId = null;
        deletingTradeId = null;
        loadAndRender().then(restartLiveStream);
      });
    });
    document.getElementById("range-select").addEventListener("change", (e) => {
      state.range = e.target.value;
      setActiveButtons();
      writeHash();
      setMarkingMode(false);
      closeTradeForm();
      loadAndRender().then(restartLiveStream);
    });
    document.getElementById("spy-timeframe-select").addEventListener("change", (e) => {
      state.spyTimeframe = e.target.value;
      rerenderSpyTimeframe();
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

  // Runs after the Daily view is already rendered and visible with
  // Kraken's own ~720-day window, so the chart is never blank while this
  // is in flight. Prepends everything older that Kraken's API
  // structurally can't return (see the COINBASE_* constants above), then
  // re-renders once ready - best-effort, and deliberately quiet on
  // failure beyond a console log: if Coinbase is unreachable the Daily
  // view still works exactly as it did before this feature existed.
  async function loadDeepDailyHistoryInBackground(asset, range, krakenCandles, levelsWindowDays) {
    if (!krakenCandles.length) return;
    try {
      const deepHistory = await fetchCoinbaseDailyHistory(COINBASE_PRODUCT_IDS[asset]);
      if (state.asset !== asset || state.range !== range) return; // user moved on while this was in flight
      const cutoff = krakenCandles[0].time;
      const older = deepHistory.filter((c) => c.time < cutoff);
      if (!older.length) return;
      const candles = [...older, ...krakenCandles];
      // renderChart()'s own default-zoom call changes the visible time
      // range, which fires the existing time-axis subscription straight
      // into renderOverlays() - label/heatmap positions refresh for free,
      // no need to redo renderLevels() (that would pointlessly tear down
      // and recreate every native price line for levels that haven't
      // actually changed).
      renderChart(candles, range, levelsWindowDays);
      activeCandles = candles;
      renderTradeMarkers(asset, range, candles);
    } catch (err) {
      console.error("deep daily history unavailable, Daily keeps showing Kraken's own ~2 years", err);
    }
  }

  // --- main load ---

  async function loadAndRender() {
    renderDecisionLoading();
    setChartLoading(true);
    try {
      if (state.asset === "spy") {
        await loadAndRenderSpy();
        return;
      }
      const asset = state.asset;
      const range = state.range;
      try {
        const [levelsData, krakenCandles] = await Promise.all([
          fetchJson(levelsUrl(asset)),
          fetchKrakenCandles(ASSET_PAIRS[asset], RANGE_INTERVALS[range]),
        ]);

        // if the user switched asset/range again while this was in flight,
        // a newer loadAndRender() call either already finished or is about
        // to - drawing this now-stale result would stomp it.
        if (state.asset !== asset || state.range !== range) return;

        const candles = krakenCandles;
        const latestCandle = candles[candles.length - 1];
        const initialLivePrice = latestCandle && Number.isFinite(latestCandle.close)
          ? latestCandle.close
          : levelsData.price;

        renderHeader(levelsData, initialLivePrice);
        activeStrategyRange = asset === "btc"
          ? RangeDecision.strategyRangeFromRegime(levelsData.structural_reclaim)
          : RangeDecision.BTC_MACRO_RANGE;
        renderStructuralReclaimProof(asset === "btc" ? levelsData.structural_reclaim : null);
        if (asset === "btc") {
          renderStructuralReclaimAudit(levelsData.structural_reclaim_audit);
          maybeSendStructuralReclaimAlert(levelsData.structural_reclaim_audit);
        }
        renderFuturesContext(levelsData.futures_context);
        // set before renderChart(): its zoom call can trigger the time-axis
        // subscription straight into renderOverlays() (which draws the
        // heatmap), and that would otherwise run once against the previous
        // asset's bins before renderLevels() below gets a chance to update it.
        activeLiquidationBins = levelsData.liquidation_estimate || [];
        previousLivePrice = null;
        lastLivePrice = initialLivePrice;
        lastLiveTickAt = latestCandle ? Date.now() : null;
        renderChartLiveTicker(latestCandle ? "live" : "reconnecting");
        // Publish the core asset state before any supplemental scorecard or
        // proximity requests. The interval poll can fire while those are in
        // flight and must never redraw the previous asset's levels.
        activeLevels = levelsData.levels;
        activeScorecard = null;
        activeProximity = null;
        renderChart(candles, range, levelsData.config.range_days);
        renderLevels(activeLevels);
        // Walls are asset-specific live data. Never carry the previous
        // asset's cache across a BTC/ETH switch while the fresh request is
        // still in flight (or if it fails).
        renderOrderBookWalls(null);

        activeCandles = candles;
        renderRangeDecision(activeLevels, null, initialLivePrice);
        renderTradeMarkers(asset, range, candles);
        renderTradesTable(asset, lastLivePrice);

        if (asset === "btc") {
          try {
            const rangeLabData = await fetchJson(rangeLabUrl());
            if (state.asset === asset && state.range === range) renderRangeLab(rangeLabData);
          } catch (err) {
            if (state.asset !== asset || state.range !== range) return;
            console.error("range lab unavailable", err);
            renderRangeLab(null);
          }
        } else {
          renderRangeLab(null);
        }

        // Deliberately not awaited: Coinbase's ~13-page pagination takes a
        // few real seconds, and blocking the chart on it meant Daily sat
        // blank that whole time on every switch, not just the first -
        // looked exactly like a frozen/broken view. Render fast with what
        // Kraken already gave us (same as before this feature existed),
        // then pop in the deeper history once it's actually ready.
        if (range === "1d") {
          loadDeepDailyHistoryInBackground(asset, range, krakenCandles, levelsData.config.range_days);
        }

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

        renderTable(levelsData.levels, initialLivePrice, scorecard, levelsData.diff);
        renderScorecardTable(scorecard);

        activeScorecard = scorecard;
        activeProximity = proximity;
        renderNearestLevels(activeLevels, activeScorecard, initialLivePrice);
        renderRangeDecision(activeLevels, activeScorecard, initialLivePrice);
        renderRoundProximityBands(initialLivePrice, activeProximity);
        renderLevelJumpSelect(activeLevels, initialLivePrice);
        renderExhaustionBanner(levelsData.exhaustion_pattern, scorecard && scorecard["Exhaustion pattern"]);
      } catch (err) {
        if (state.asset !== asset || state.range !== range) return;
        console.error(err);
        renderDecisionUnavailable("Price or level data is currently unavailable.");
        const banner = document.getElementById("stale-banner");
        banner.hidden = false;
        banner.textContent = "Could not load level or price data — either the daily workflow hasn't run yet, or Kraken's API is unreachable right now.";
      }
    } finally {
      setChartLoading(false);
    }
  }

  organizeAdvancedAnalysis();
  organizePrimaryLayout();
  wireMobileJumpNav();
  wireAdvancedAnalysis();
  wireNearbyContext();
  readHash();
  setActiveButtons();
  wireToggles();
  wirePatienceAlerts();
  wireTradeForm();
  wireLevelJumpSelect();
  if (window.MarketSessions) MarketSessions.mount(document, state.asset);
  loadAndRender().then(startLiveStreaming);
})();
