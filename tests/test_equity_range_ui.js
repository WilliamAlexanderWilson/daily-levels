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
  assert.match(app, /renderSpyChart\(bars, chartData\.range_context\)/);
});

test("equity range copy remains context-only and never a direct signal", () => {
  assert.match(app, /deterministic price-location context, not a validated edge/);
  assert.match(app, /Do not short the level automatically/);
  assert.match(app, /Do not fade the breakout automatically/);
  assert.match(app, /renderSpyDecision\(rangeResearch\)/);
});

test("versioned assets prevent an old BTC app bundle from rendering new tabs", () => {
  assert.match(index, /styles\.css\?v=full-history-v1/);
  assert.match(index, /app\.js\?v=full-history-v1/);
});

test("every timeframe stays fitted to all loaded history", () => {
  assert.match(app, /function fitAllLoadedHistory\(\)/);
  assert.match(app, /handleScroll: false/);
  assert.match(app, /axisPressedMouseMove: \{ time: false, price: true \}/);
  assert.match(app, /mouseWheel: false/);
  assert.match(app, /pinch: false/);
  assert.doesNotMatch(app, /setVisibleLogicalRange/);
  assert.doesNotMatch(app, /function applyDefaultZoom/);
  assert.match(app, /function renderChart[\s\S]*?fitAllLoadedHistory\(\)/);
  assert.match(app, /function renderSpyChart[\s\S]*?fitAllLoadedHistory\(\)/);
  assert.match(app, /if \(addedNewCandle\) fitAllLoadedHistory\(\)/);
  assert.match(app, /new ResizeObserver\(scheduleFullHistoryFit\)/);
  assert.match(app, /historyFitFrame = requestAnimationFrame\(\(\) => \{[\s\S]*?historyFitFrame = requestAnimationFrame/);
  assert.match(app, /all loaded batch history/);
});

test("a new batch fetch clears the prior asset before the request can fail", () => {
  const loader = app.match(/async function loadAndRenderBatch\(\) \{[\s\S]*?\n  \}/)[0];
  assert.ok(loader.indexOf("activeSpyChart = null") < loader.indexOf("await fetchJson"));
  assert.ok(loader.indexOf("renderSpyChart([], null)") < loader.indexOf("await fetchJson"));
  assert.ok(loader.indexOf('document.getElementById("price-label").textContent = "—"') < loader.indexOf("await fetchJson"));
});
