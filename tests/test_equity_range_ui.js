const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const app = fs.readFileSync(path.join(__dirname, "..", "site", "app.js"), "utf8");
const index = fs.readFileSync(path.join(__dirname, "..", "site", "index.html"), "utf8");

test("batch equity charts draw reproducible range edges and midpoint", () => {
  assert.match(app, /function renderBatchRangeLines\(range\)/);
  assert.match(app, /Lower edge/);
  assert.match(app, /Upper edge/);
  assert.match(app, /Midpoint/);
  assert.match(app, /renderSpyChart\(regularBars, chartData\.range_context\)/);
});

test("equity range copy remains context-only and never a direct signal", () => {
  assert.match(app, /deterministic price-location context, not a validated edge/);
  assert.match(app, /Do not short the level automatically/);
  assert.match(app, /Do not fade the breakout automatically/);
  assert.match(app, /renderSpyDecision\(rangeResearch\)/);
});

test("versioned assets prevent an old BTC app bundle from rendering new tabs", () => {
  assert.match(index, /styles\.css\?v=deep-history-xau-v1/);
  assert.match(index, /candle-style\.js\?v=spy-doji-v1/);
  assert.match(index, /doji-study\.js\?v=spy-doji-v1/);
  assert.match(index, /candle-history\.js\?v=deep-history-v1/);
  assert.match(index, /app\.js\?v=chart-nav-v1/);
});

test("crypto charts can page backward beyond Kraken's 720-candle window", () => {
  assert.match(index, /id="history-load-status"/);
  assert.match(app, /CandleHistory\.requestWindow/);
  assert.match(app, /CandleHistory\.fromCoinbaseRows/);
  assert.match(app, /CandleHistory\.mergeOlder/);
  assert.match(app, /barsInLogicalRange/);
  assert.match(app, /loadOlderCryptoHistory/);
});

test("batch charts page backward through monthly published archives", () => {
  assert.match(app, /loadBatchArchiveManifest/);
  assert.match(app, /loadOlderBatchHistory/);
  assert.match(app, /data\/archive\/\$\{asset\}\/manifest\.json/);
  assert.match(app, /loadedBatchArchivePaths/);
});

test("regular and Heikin Ashi styles are explicit reversible controls", () => {
  assert.match(index, /id="candle-style-toggle"/);
  assert.match(index, /data-candle-style="regular"/);
  assert.match(index, /data-candle-style="heikin-ashi"/);
  assert.match(app, /state\.candleStyle = nextStyle/);
  assert.match(app, /CandleStyle\.forStyle\(candles, state\.candleStyle\)/);
  assert.match(app, /CandleStyle\.forStyle\(regularBars, state\.candleStyle\)/);
  assert.match(app, /params\.set\("style", "ha"\)/);
});

test("completed Heikin Ashi dojis are a SPY-only study", () => {
  assert.match(index, /id="doji-study-status"/);
  assert.match(index, /id="doji-study-status"[^>]*hidden/);
  assert.match(app, /const enabled = state\.asset === "spy"/);
  assert.match(app, /document\.getElementById\("doji-study-status"\)\.hidden = asset !== "spy"/);
  assert.match(app, /DojiStudy\.findCompleted\(candles/);
  assert.match(app, /Number\(intervalMinutes\) >= DojiStudy\.MIN_TIMEFRAME_MINUTES/);
  assert.match(app, /text: "D"/);
  assert.match(app, /timeIsClose: true/);
  assert.match(app, /timeIsClose: false/);
});

test("every timeframe opens fitted and then supports normal chart navigation", () => {
  assert.match(app, /function fitAllLoadedHistory\(\)/);
  assert.match(index, /id="fit-chart-btn"/);
  assert.match(app, /mouseWheel: true/);
  assert.match(app, /pressedMouseMove: true/);
  assert.match(app, /horzTouchDrag: true/);
  assert.match(app, /axisPressedMouseMove: \{ time: true, price: true \}/);
  assert.match(app, /pinch: true/);
  assert.match(app, /fixLeftEdge: false/);
  assert.match(app, /fixRightEdge: false/);
  assert.match(app, /restorePrependedHistoryViewport/);
  assert.match(app, /setVisibleLogicalRange/);
  assert.match(index, /id="latest-chart-btn"/);
  assert.doesNotMatch(app, /function applyDefaultZoom/);
  assert.match(app, /function renderChart[\s\S]*?fitAllLoadedHistory\(\)/);
  assert.match(app, /function renderSpyChart[\s\S]*?fitAllLoadedHistory\(\)/);
  assert.match(app, /getElementById\("fit-chart-btn"\)[\s\S]*?fitAllLoadedHistory\(\)/);
  assert.match(app, /new ResizeObserver\(scheduleFullHistoryFit\)/);
  assert.match(app, /historyFitFrame = requestAnimationFrame\(\(\) => \{[\s\S]*?historyFitFrame = requestAnimationFrame/);
  assert.match(app, /complete published archive/);
});

test("the chart workspace fills wide screens with a small responsive edge", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "site", "styles.css"), "utf8");
  assert.match(css, /--shell-gutter: clamp\(0\.75rem, 1\.5vw, 2rem\)/);
  assert.match(css, /\.site-header[\s\S]*?width: calc\(100% - \(2 \* var\(--shell-gutter\)\)\)/);
  assert.match(css, /main \{[\s\S]*?max-width: none/);
  assert.match(css, /height: clamp\(560px, 68svh, 920px\)/);
  assert.match(css, /height: clamp\(390px, 64svh, 620px\)/);
});

test("a new batch fetch clears the prior asset before the request can fail", () => {
  const loader = app.match(/async function loadAndRenderBatch\(\) \{[\s\S]*?\n  \}/)[0];
  assert.ok(loader.indexOf("activeSpyChart = null") < loader.indexOf("await fetchJson"));
  assert.ok(loader.indexOf("renderSpyChart([], null)") < loader.indexOf("await fetchJson"));
  assert.ok(loader.indexOf('document.getElementById("price-label").textContent = "—"') < loader.indexOf("await fetchJson"));
});
