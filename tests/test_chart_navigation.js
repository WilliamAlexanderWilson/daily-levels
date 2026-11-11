const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const app = fs.readFileSync(path.join(__dirname, "..", "site", "app.js"), "utf8");

function loadFunction(name, nextName, context) {
  const start = app.indexOf(`  function ${name}(`);
  let end = app.indexOf(`  function ${nextName}(`, start);
  if (end < 0) end = app.indexOf(`  async function ${nextName}(`, start);
  assert.ok(start >= 0 && end > start, `${name} source exists`);
  vm.runInNewContext(app.slice(start, end), context);
  return context[name];
}

test("prepending history preserves the same bars and zoom on screen", () => {
  let restored = null;
  const context = {
    chart: { timeScale: () => ({ setVisibleLogicalRange: (range) => { restored = range; } }) },
  };
  const restore = loadFunction("restorePrependedHistoryViewport", "fetchCoinbaseHistoryPage", context);
  restore({ from: 12.5, to: 45.5 }, 200);
  assert.deepEqual({ ...restored }, { from: 212.5, to: 245.5 });
  restore(null, 200);
  restore({ from: 12.5, to: 45.5 }, 0);
  assert.deepEqual({ ...restored }, { from: 212.5, to: 245.5 });
  assert.match(app, /applyMergedCryptoHistory\(merged, range\);\s*restorePrependedHistoryViewport\(visibleRange, added\)/);
  assert.match(app, /renderSpyChart\(merged, activeSpyChart\.range_context, merged\.length - current\.length\)/);
  assert.match(app, /latestVisibleLogicalRange = logicalRange/);
  assert.match(app, /const visibleRange = latestVisibleLogicalRange \|\| chart\.timeScale\(\)\.getVisibleLogicalRange\(\)/);
});

test("return control appears for a distant latest candle or large future gap", () => {
  const button = { hidden: true };
  const context = {
    document: { getElementById: () => button },
    activeDisplayCandles: Array(100),
    state: { asset: "btc" },
    isBatchAsset: (asset) => asset === "spy",
  };
  const update = loadFunction("updateLatestChartControl", "restorePrependedHistoryViewport", context);
  update({ from: 50, to: 102 });
  assert.equal(button.hidden, true);
  update({ from: 50, to: 130 });
  assert.equal(button.hidden, false);
  assert.equal(button.textContent, "Latest");
  update({ from: 10, to: 80 });
  assert.equal(button.hidden, false);
  context.state.asset = "spy";
  update({ from: 50, to: 130 });
  assert.equal(button.textContent, "Newest");
});
