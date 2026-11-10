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
  assert.match(index, /styles\.css\?v=equity-ranges-v1/);
  assert.match(index, /app\.js\?v=equity-ranges-v1/);
});
