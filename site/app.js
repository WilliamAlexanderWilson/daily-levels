(function () {
  "use strict";

  const STALE_HOURS = 26;
  const LIVE_POLL_MS = 15000;
  const KRAKEN_OHLC_URL = "https://api.kraken.com/0/public/OHLC";
  const ASSET_PAIRS = { btc: "BTC/USD", eth: "ETH/USD" };
  const RANGE_INTERVALS = { "4h": 240, "1d": 1440 };

  const state = {
    asset: "btc",
    range: "4h",
  };

  function readHash() {
    const params = new URLSearchParams(location.hash.replace(/^#/, ""));
    if (params.get("asset") === "eth") state.asset = "eth";
    if (params.get("range") === "1d") state.range = "1d";
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

  function candlesUrl(asset, range) {
    const suffix = range === "1d" ? "1d" : "4h";
    return `data/${asset}_candles_${suffix}.json`;
  }

  // --- chart ---

  let chart = null;
  let candleSeries = null;
  let volumeSeries = null;
  const activePriceLines = [];
  const zoneOverlayEls = [];
  let currentZones = []; // {low, high, color} for repositioning on redraw
  let lastLiveUnixTime = null; // guards against feeding series.update() a time older than its last bar

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
      // an unlabeled horizontal line at the last close would just clutter
      // the chart next to our own named level lines; the small price tag
      // on the axis (lastValueVisible, left on) is enough of a "you are
      // here" marker.
      priceLineVisible: false,
    });

    volumeSeries = chart.addSeries(LightweightCharts.HistogramSeries, {
      color: cssVar("--text-muted"),
      priceFormat: { type: "volume" },
      priceScaleId: "",
    });
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

    chart.timeScale().subscribeVisibleLogicalRangeChange(renderZoneOverlays);
    window.addEventListener("resize", renderZoneOverlays);
  }

  function clearPriceLines() {
    for (const line of activePriceLines) {
      candleSeries.removePriceLine(line);
    }
    activePriceLines.length = 0;
  }

  function clearZoneOverlays() {
    for (const el of zoneOverlayEls) el.remove();
    zoneOverlayEls.length = 0;
    currentZones = [];
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
    clearZoneOverlays();

    for (const level of levels) {
      const style = styleForLevel(level);
      const isZone = level.price_high > level.price_low;
      const label = `${level.name}${isZone ? "" : ""} (${level.strength})`;

      if (isZone) {
        const top = candleSeries.createPriceLine({
          price: level.price_high,
          color: style.color,
          lineWidth: style.lineWidth,
          lineStyle: style.lineStyle,
          axisLabelVisible: true,
          title: label,
        });
        const bottom = candleSeries.createPriceLine({
          price: level.price_low,
          color: style.color,
          lineWidth: style.lineWidth,
          lineStyle: style.lineStyle,
          axisLabelVisible: false,
          title: "",
        });
        activePriceLines.push(top, bottom);
        currentZones.push({ low: level.price_low, high: level.price_high, color: style.color });
      } else {
        const line = candleSeries.createPriceLine({
          price: level.price_low,
          color: style.color,
          lineWidth: style.lineWidth,
          lineStyle: style.lineStyle,
          axisLabelVisible: true,
          title: label,
        });
        activePriceLines.push(line);
      }
    }

    renderZoneOverlays();
  }

  function renderZoneOverlays() {
    const container = document.getElementById("chart-container");
    for (const el of zoneOverlayEls) el.remove();
    zoneOverlayEls.length = 0;

    if (!candleSeries) return;

    for (const zone of currentZones) {
      const yTop = candleSeries.priceToCoordinate(zone.high);
      const yBottom = candleSeries.priceToCoordinate(zone.low);
      if (yTop === null || yBottom === null) continue;

      const el = document.createElement("div");
      el.className = "zone-overlay";
      el.style.top = `${yTop}px`;
      el.style.height = `${Math.max(1, yBottom - yTop)}px`;
      el.style.background = zone.color;
      el.style.opacity = "0.12";
      container.appendChild(el);
      zoneOverlayEls.push(el);
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

  function renderChart(candles, range) {
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
    chart.timeScale().fitContent();

    // a fresh setData() resets what counts as "the last bar" - any
    // in-flight live poll's monotonic guard needs to reset with it.
    lastLiveUnixTime = null;
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
      const url = `${KRAKEN_OHLC_URL}?pair=${encodeURIComponent(pair)}&interval=${interval}&assetVersion=1`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) return noteLiveMiss();
      const payload = await res.json();
      if (payload.error && payload.error.length) return noteLiveMiss();
      const rows = payload.result && payload.result[pair];
      if (!rows || rows.length === 0) return noteLiveMiss();

      // the toggle may have moved on to a different asset/range while this
      // request was in flight - if so, drop the result rather than draw it
      // onto the wrong series. Not a failure, so don't touch the miss count.
      if (state.asset !== asset || state.range !== range) return;

      // last 2 rows: the current forming candle, plus the previous one in
      // case it just closed between polls and we'd otherwise miss its
      // final close.
      const recent = rows.slice(-2);
      let lastClose = null;

      for (const row of recent) {
        const [time, open] = row;
        const high = row[2];
        const low = row[3];
        const close = row[4];
        const volume = row[6];

        // series.update() throws if fed a time older than its current last
        // bar (e.g. a stale row left over from a reconnect, or any other
        // ordering surprise) - skip rather than risk it.
        if (lastLiveUnixTime !== null && time < lastLiveUnixTime) continue;

        const point = { time: toTimePoint({ time }, range) };

        candleSeries.update({
          ...point,
          open: +open,
          high: +high,
          low: +low,
          close: +close,
        });
        volumeSeries.update({
          ...point,
          value: +volume,
          color: +close >= +open ? cssVar("--support") : cssVar("--resistance"),
        });
        lastLiveUnixTime = time;
        lastClose = +close;
      }

      if (lastClose !== null) {
        document.getElementById("price-label").textContent = lastClose.toLocaleString(undefined, {
          maximumFractionDigits: 2,
        });
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

  function renderTable(levels, currentPrice) {
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
        <td>${level.name}${level.is_flip ? " 🔒" : ""}</td>
        <td>${priceText}</td>
        <td>${level.distance_pct >= 0 ? "+" : ""}${level.distance_pct.toFixed(2)}%</td>
        <td class="type-cell">${level.is_flip ? "flip" : level.type}</td>
        <td>${level.strength}</td>
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

  // --- toggles ---

  function setActiveButtons() {
    document.querySelectorAll("#asset-toggle .toggle-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.asset === state.asset);
    });
    document.querySelectorAll("#range-toggle .toggle-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.range === state.range);
    });
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
    document.querySelectorAll("#range-toggle .toggle-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.range = btn.dataset.range;
        setActiveButtons();
        writeHash();
        loadAndRender().then(pollLiveCandle);
      });
    });
  }

  // --- main load ---

  async function loadAndRender() {
    try {
      const [levelsData, candles] = await Promise.all([
        fetchJson(levelsUrl(state.asset)),
        fetchJson(candlesUrl(state.asset, state.range)),
      ]);

      renderHeader(levelsData);
      renderChart(candles, state.range);
      renderLevels(levelsData.levels);
      renderTable(levelsData.levels, levelsData.price);
    } catch (err) {
      console.error(err);
      const banner = document.getElementById("stale-banner");
      banner.hidden = false;
      banner.textContent = "Could not load level data. Has the daily workflow run yet?";
    }
  }

  readHash();
  setActiveButtons();
  wireToggles();
  loadAndRender().then(startLivePolling);
})();
