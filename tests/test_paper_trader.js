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

test("risk plan sizes margin from account risk and stop distance", () => {
  const plan = PaperTrader.riskPlan({
    direction: "long", entry: 100, stop: 98, target: 106,
    accountBalance: 10000, riskPct: 1, leverage: 5,
  });
  assert.equal(plan.valid, true);
  assert.equal(plan.riskDollars, 100);
  assert.equal(plan.notional, 5000);
  assert.equal(plan.margin, 1000);
  assert.equal(plan.rewardRisk, 3);
  const shortPlan = PaperTrader.riskPlan({
    direction: "short", entry: 100, stop: 102, target: 94,
    accountBalance: 10000, riskPct: 1, leverage: 5,
  });
  assert.equal(shortPlan.valid, true);
  assert.equal(shortPlan.rewardRisk, 3);
});

test("risk plan rejects invalid geometry, over-risk, and a stop beyond liquidation", () => {
  assert.equal(PaperTrader.riskPlan({ direction: "long", entry: 100, stop: 101, target: 110, accountBalance: 10000, riskPct: 1, leverage: 5 }).valid, false);
  assert.equal(PaperTrader.riskPlan({ direction: "long", entry: 100, stop: 98, target: 110, accountBalance: 10000, riskPct: 0.01, leverage: 5 }).valid, false);
  assert.equal(PaperTrader.riskPlan({ direction: "long", entry: 100, stop: 98, target: 110, accountBalance: 10000, riskPct: 6, leverage: 5 }).valid, false);
  assert.equal(PaperTrader.riskPlan({ direction: "long", entry: 100, stop: 98, target: 110, accountBalance: 10000, riskPct: 1, leverage: 100 }).valid, false);
});

test("paper stops and targets are terminal and R is based on planned dollars at risk", () => {
  const trade = { direction: "long", price: 100, stopPrice: 98, targetPrice: 106, size: 1000, leverage: 5, riskDollars: 100 };
  assert.deepEqual(PaperTrader.triggeredExit(trade, 97.5), { reason: "stop", price: 98 });
  assert.deepEqual(PaperTrader.triggeredExit(trade, 106.5), { reason: "target", price: 106 });
  assert.ok(Math.abs(PaperTrader.rMultiple(trade, 102) - 1) < 1e-9);
});

test("a stop touch cannot be erased by a recovery tick inside the render throttle", () => {
  const open = [{
    id: "fast-stop", direction: "long", price: 100, stopPrice: 98,
    targetPrice: 106, size: 1000, leverage: 5, riskDollars: 100,
  }];
  const crossed = PaperTrader.settleTrades(open, 97.5, 1000);
  assert.equal(crossed.changed, true);
  assert.equal(crossed.trades[0].exitPrice, 98);
  assert.equal(crossed.trades[0].exitReason, "stop");

  const recovered = PaperTrader.settleTrades(crossed.trades, 101, 1001);
  assert.equal(recovered.changed, false);
  assert.equal(recovered.trades[0].exitPrice, 98);
  assert.equal(recovered.trades[0].exitTime, 1000);
});

test("primary chart precedes decision research and paper tracker remains outside collapsed analysis", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const html = fs.readFileSync(path.join(__dirname, "..", "site", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "..", "site", "app.js"), "utf8");
  assert.ok(html.indexOf('id="chart-container"') < html.indexOf('id="paper-trader"'));
  assert.ok(html.indexOf('id="paper-trader"') < html.indexOf('id="advanced-analysis"'));
  assert.match(html, /id="trade-form-leverage"[^>]+max="100"/);
  assert.match(html, /id="trade-form-account"/);
  assert.match(html, /id="trade-form-risk-pct"[^>]+max="5"/);
  assert.match(html, /id="trade-form-stop"/);
  assert.match(html, /id="trade-form-target"/);
  assert.match(html, /id="trade-form-size"[^>]+readonly/);
  assert.match(app, /SPY is batch data|batch SPY data/);
  assert.match(app, /liveEntryButton\.disabled = !markFresh/);
  assert.match(app, /paperLiveLabel\.textContent = markFresh \? "Live price" : "Last price"/);
  assert.match(app, /" \(last mark\)"/);
  assert.match(app, /"PAPER STOP"/);
  assert.match(app, /"PAPER TARGET"/);
  assert.ok(app.indexOf('settleTriggeredTrades(asset, candle.close)') < app.indexOf('scheduleDerivedLiveState(asset, candle.close)'));
  const presentationBody = app.slice(
    app.indexOf("function updateLiveTradePnlCells"),
    app.indexOf("function startClosingTrade"),
  );
  assert.doesNotMatch(presentationBody, /settleTriggeredTrades/);
  assert.match(app, /source === "stream" && liveMarkIsFresh\(\)/);
  assert.match(app, /"range-lab",\s+"nearby-context"/);
  assert.doesNotMatch(app, /selectRangeLabCandidate\(activeRangeLabCandidateKey \|\| RangeLab\.defaultKey/);
  assert.match(app, /if \(!details\.open\) \{[\s\S]*clearRangeLabLines\(\)/);
  assert.match(app, /activeRangeLabCandidateKey && activeRangeLabData/);
  assert.match(html, /Research &amp; details/);
  assert.match(html, /Trade checklist/);
});
