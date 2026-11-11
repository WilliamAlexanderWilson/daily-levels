const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const app = fs.readFileSync(path.join(__dirname, "..", "site", "app.js"), "utf8");
const start = app.indexOf("  function renderHeader(");
const end = app.indexOf("  function renderStructuralReclaimProof(", start);
assert.ok(start >= 0 && end > start);
const renderHeaderSource = app.slice(start, end);
const NOW = Date.parse("2026-11-11T12:00:00Z");

function render(asset, generatedAt) {
  const elements = Object.fromEntries(
    ["generated-label", "price-label", "stale-banner"].map((id) => [id, { textContent: "", hidden: true }])
  );
  class Clock extends Date {
    static now() { return NOW; }
  }
  const context = {
    Date: Clock,
    Intl,
    Number,
    state: { asset },
    STALE_HOURS: 26,
    BATCH_STALE_HOURS: 18,
    isBatchAsset: (value) => ["spy", "qqq", "nvda", "xau"].includes(value),
    document: { getElementById: (id) => elements[id] },
  };
  const renderHeader = vm.runInNewContext(`${renderHeaderSource}\nrenderHeader`, context);
  renderHeader({ generated_at_utc: generatedAt, price: 123.45 });
  return elements;
}

test("fresh batch data identifies the selected source and stays clear", () => {
  const elements = render("xau", "2026-11-11T01:00:00Z");
  assert.match(elements["generated-label"].textContent, /^XAU batch published /);
  assert.equal(elements["stale-banner"].hidden, true);
});

test("stale batch data names the affected asset", () => {
  const elements = render("qqq", "2026-11-10T17:00:00Z");
  assert.equal(elements["stale-banner"].hidden, false);
  assert.match(elements["stale-banner"].textContent, /QQQ batch data was published 19 hours ago/);
  assert.match(elements["stale-banner"].textContent, /scheduled export/);
});

test("invalid or future batch timestamps fail visibly", () => {
  for (const timestamp of ["invalid", "2026-11-11T12:10:00Z"]) {
    const elements = render("spy", timestamp);
    assert.equal(elements["stale-banner"].hidden, false);
    assert.match(elements["stale-banner"].textContent, /SPY batch timestamp is unavailable or invalid/);
  }
});

test("crypto levels retain their daily threshold", () => {
  const elements = render("btc", "2026-11-10T11:00:00Z");
  assert.equal(elements["stale-banner"].hidden, true);
  assert.match(elements["generated-label"].textContent, /^Levels calculated /);
});
