const test = require("node:test");
const assert = require("node:assert/strict");
const PaperTrader = require("../site/paper-trader.js");

test("accepts only whole-number leverage from 1x through 100x", () => {
  assert.equal(PaperTrader.normalizeLeverage(1), 1);
  assert.equal(PaperTrader.normalizeLeverage("100"), 100);
  for (const invalid of [0, 101, 10.5, "", null, undefined]) {
    assert.equal(PaperTrader.normalizeLeverage(invalid), null);
  }
});

test("marks long and short paper P&L from margin times leverage", () => {
  const long = PaperTrader.pnl({ direction: "long", price: 100, size: 500, leverage: 10 }, 102);
  const short = PaperTrader.pnl({ direction: "short", price: 100, size: 500, leverage: 10 }, 98);
  assert.ok(Math.abs(long.usd - 100) < 1e-9);
  assert.ok(Math.abs(long.pct - 20) < 1e-9);
  assert.equal(long.isRealized, false);
  assert.ok(Math.abs(short.usd - 100) < 1e-9);
  assert.ok(Math.abs(short.pct - 20) < 1e-9);
  assert.equal(short.isRealized, false);
});

test("a closed position remains frozen at its exit mark", () => {
  const result = PaperTrader.pnl({ direction: "long", price: 100, exitPrice: 99, size: 200, leverage: 5 }, 120);
  assert.equal(result.usd, -10);
  assert.equal(result.pct, -5);
  assert.equal(result.isRealized, true);
});

test("liquidation estimate reflects direction and 100x one-percent distance", () => {
  assert.equal(PaperTrader.estimatedLiquidationPrice({ direction: "long", price: 75000, leverage: 100 }), 74250);
  assert.equal(PaperTrader.estimatedLiquidationPrice({ direction: "short", price: 75000, leverage: 100 }), 75750);
  assert.equal(PaperTrader.estimatedLiquidationPrice({ direction: "long", price: 75000, leverage: 101 }), null);
});

test("a paper position stops at estimated liquidation instead of showing recoverable losses beyond margin", () => {
  const long = { direction: "long", price: 75000, size: 500, leverage: 100 };
  const short = { direction: "short", price: 75000, size: 500, leverage: 100 };
  assert.equal(PaperTrader.isLiquidationCrossed(long, 74249), true);
  assert.equal(PaperTrader.isLiquidationCrossed(short, 75751), true);
  assert.deepEqual(PaperTrader.pnl(long, 73500), {
    usd: -500,
    pct: -100,
    isRealized: false,
    isLiquidated: true,
  });
  assert.deepEqual(PaperTrader.pnl(short, 76500), {
    usd: -500,
    pct: -100,
    isRealized: false,
    isLiquidated: true,
  });
});

test("primary chart precedes decision research and paper tracker remains outside collapsed analysis", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const html = fs.readFileSync(path.join(__dirname, "..", "site", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "..", "site", "app.js"), "utf8");
  assert.ok(html.indexOf('id="chart-container"') < html.indexOf('id="paper-trader"'));
  assert.ok(html.indexOf('id="paper-trader"') < html.indexOf('id="advanced-analysis"'));
  assert.match(html, /id="trade-form-leverage"[^>]+max="100"/);
  assert.match(app, /SPY is batch data|batch SPY data/);
  assert.match(app, /liveEntryButton\.disabled = !liveMarkIsFresh\(\)/);
  assert.match(app, /" \(last mark\)"/);
});
