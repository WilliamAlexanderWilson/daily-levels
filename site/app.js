(function () {
  "use strict";

  const STALE_HOURS = 26;
  const LIVE_POLL_MS = 15000;
  const KRAKEN_OHLC_URL = "https://api.kraken.com/0/public/OHLC";
  const ASSET_PAIRS = { btc: "BTC/USD", eth: "ETH/USD" };
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

  // --- chart ---

  let chart = null;
  let candleSeries = null;
  let volumeSeries = null;
  const activePriceLines = [];
  const overlayEls = [];
  let currentMarkers = []; // {low, high, mid, color, label, isZone} for repositioning on redraw
  let lastLiveUnixTime = null; // guards against feeding series.update() a time older than its last bar

  // the daily levels + scorecard, kept around so the nearest-level cards
  // can be recomputed on every live price tick, not just on load/toggle.
  let activeLevels = [];
  let activeScorecard = null;

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
      scaleMargins: { top: 0.08, bottom: 0.3 },
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

    chart.timeScale().subscribeVisibleLogicalRangeChange(renderOverlays);
    window.addEventListener("resize", renderOverlays);
  }

  function clearPriceLines() {
    for (const line of activePriceLines) {
      candleSeries.removePriceLine(line);
    }
    activePriceLines.length = 0;
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

  function renderLevels(levels) {
    clearPriceLines();
    clearOverlays();

    for (const level of levels) {
      const style = styleForLevel(level);
      const isZone = level.price_high > level.price_low;
      const label = `${level.name} (${level.strength})`;

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
      }

      currentMarkers.push({
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

  // Resolves overlaps by clustering nearby labels and centering each
  // cluster on its own natural (average) position, rather than cascading
  // every later label downward from the topmost one. A forward-only
  // cascade drifts badly on a short chart (mobile) when several labels
  // cluster near the top - it can push a label tens of pixels from its
  // actual line, past other, unrelated lines. Centering keeps each
  // cluster's drift local to where it actually is.
  function declutter(items, minGap) {
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
    // touching - one more forward pass guarantees no residual overlap.
    placed.sort((a, b) => a.y - b.y);
    for (let i = 1; i < placed.length; i++) {
      const minY = placed[i - 1].y + minGap;
      if (placed[i].y < minY) placed[i].y = minY;
    }
    return placed;
  }

  function renderOverlays() {
    const container = document.getElementById("chart-container");
    for (const el of overlayEls) el.remove();
    overlayEls.length = 0;

    if (!candleSeries) return;

    // zone shading draws at its exact price - only the text tags get
    // decluttered below.
    for (const marker of currentMarkers) {
      if (!marker.isZone) continue;
      const yTop = candleSeries.priceToCoordinate(marker.high);
      const yBottom = candleSeries.priceToCoordinate(marker.low);
      if (yTop === null || yBottom === null) continue;

      const band = document.createElement("div");
      band.className = "zone-overlay";
      band.style.top = `${yTop}px`;
      band.style.height = `${Math.max(1, yBottom - yTop)}px`;
      band.style.background = marker.color;
      band.style.opacity = "0.12";
      container.appendChild(band);
      overlayEls.push(band);
    }

    // Several levels often cluster within a few % of each other, which
    // can be a tiny sliver of pixels once zoomed out (e.g. the Daily view
    // spanning a 2-year price range) - without this pass their text tags
    // would stack directly on top of each other.
    const rawPositions = currentMarkers
      .map((marker) => ({ marker, y: candleSeries.priceToCoordinate(marker.mid) }))
      .filter((p) => p.y !== null);
    const placements = declutter(rawPositions, LABEL_MIN_GAP_PX);

    for (const { marker, y, trueY } of placements) {
      // dense clusters (common on a short/mobile chart) can still need to
      // push a label a visible distance from its real line - a leader
      // connects the two so it's never ambiguous which line a tag belongs
      // to, even when displaced.
      if (Math.abs(y - trueY) > 1) {
        const leader = document.createElement("div");
        leader.className = "level-label-leader";
        leader.style.top = `${Math.min(y, trueY)}px`;
        leader.style.height = `${Math.abs(y - trueY)}px`;
        leader.style.background = marker.color;
        container.appendChild(leader);
        overlayEls.push(leader);
      }

      const tag = document.createElement("div");
      tag.className = "level-label";
      tag.style.top = `${y}px`;
      tag.style.background = marker.color;
      tag.textContent = marker.label;
      tag.title = marker.label;
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

  function renderChart(candles, range, levelsWindowDays) {
    ensureChart();
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

    if (range === "4h" && levelsWindowDays) {
      // POC/VAH/VAL/range high-low are computed from the same
      // levelsWindowDays lookback. Open already framed to that same
      // window so those lines land on the actual high/low on screen,
      // instead of fitContent() showing ~120 days (the full fetch) and
      // making a 60-day-scoped level look like it's ignoring an older,
      // bigger wick further left.
      const candlesPerDay = 6; // 24h / 4h
      const windowBars = levelsWindowDays * candlesPerDay;
      const marginBars = Math.round(windowBars * 0.08);
      const from = Math.max(0, candleData.length - windowBars - marginBars);
      const to = candleData.length + 1;
      chart.timeScale().setVisibleLogicalRange({ from, to });
    } else {
      // Daily view: full fetched history. There's no single lookback
      // window that cleanly maps to every Daily-relevant stat (golden
      // pocket uses a longer window than range high/low does), so this
      // stays a "zoom out for context, labels already say their own
      // scope" view rather than forcing a crop that still wouldn't
      // match everything.
      chart.timeScale().fitContent();
    }

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
      }

      consecutiveMisses = 0;
      setLiveBadge("live");
    } catch (err) {
      console.error("live poll failed", err);
      noteLiveMiss();
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

  function renderNearestLevels(levels, scorecard, currentPrice) {
    if (!levels || !levels.length || currentPrice === null || currentPrice === undefined) {
      document.getElementById("nearest-resistance-card").hidden = true;
      document.getElementById("nearest-support-card").hidden = true;
      return;
    }

    // Recomputed off the live price, not the level's own type field - that
    // field reflects the price at the daily snapshot, which can be stale
    // by the time the live price has moved past a level.
    let nearestAbove = null;
    let nearestBelow = null;
    for (const level of levels) {
      const mid = (level.price_low + level.price_high) / 2;
      if (mid > currentPrice && (nearestAbove === null || mid < (nearestAbove.price_low + nearestAbove.price_high) / 2)) {
        nearestAbove = level;
      }
      if (mid < currentPrice && (nearestBelow === null || mid > (nearestBelow.price_low + nearestBelow.price_high) / 2)) {
        nearestBelow = level;
      }
    }

    fillNearestCard("nearest-resistance-card", nearestAbove, currentPrice, scorecard);
    fillNearestCard("nearest-support-card", nearestBelow, currentPrice, scorecard);
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
      tr.className = `type-${level.type}${level.is_flip ? " is-flip" : ""}`;

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
        loadAndRender().then(pollLiveCandle);
      });
    });
    document.getElementById("range-select").addEventListener("change", (e) => {
      state.range = e.target.value;
      setActiveButtons();
      writeHash();
      loadAndRender().then(pollLiveCandle);
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
      renderChart(candles, range, levelsData.config.range_days);
      renderLevels(levelsData.levels);

      // The scorecard is a nice-to-have, not core - if it's missing (first
      // rollout before a backtest has run, or a fetch hiccup) the levels
      // table and chart should still render fine, just without hold rates.
      let scorecard = null;
      try {
        scorecard = await fetchJson(scorecardUrl(asset));
      } catch (err) {
        console.error("scorecard unavailable", err);
      }
      if (state.asset !== asset || state.range !== range) return;

      renderTable(levelsData.levels, levelsData.price, scorecard, levelsData.diff);
      renderScorecardTable(scorecard);

      activeLevels = levelsData.levels;
      activeScorecard = scorecard;
      renderNearestLevels(activeLevels, activeScorecard, levelsData.price);
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
  loadAndRender().then(startLivePolling);
})();
