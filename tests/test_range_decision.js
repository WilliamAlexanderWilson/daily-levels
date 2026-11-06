const test = require("node:test");
const assert = require("node:assert/strict");
const { build, patienceAlertFingerprint, patienceState, recentBoundaryTest } = require("../site/range-decision.js");

const levels = [
  { name: "Range low (60d)", price_low: 80, price_high: 80 },
  { name: "VAL (60d)", price_low: 90, price_high: 90 },
  { name: "POC (60d)", price_low: 100, price_high: 100 },
  { name: "VAH (60d)", price_low: 110, price_high: 110 },
  { name: "Range high (60d)", price_low: 120, price_high: 120 },
];

const scorecard = {
  "VAL (60d)": { hold_rate_pct: 61, resolved: 40, low_confidence: false },
  "POC (60d)": { hold_rate_pct: 48, resolved: 50, low_confidence: false },
};

test("marks the lower edge of the active bracket as a long watch", () => {
  const decision = build(levels, scorecard, 92);
  assert.equal(decision.status, "long-watch");
  assert.equal(decision.support.name, "VAL (60d)");
  assert.equal(decision.resistance.name, "POC (60d)");
  assert.ok(decision.longRewardRisk > 1);
  assert.equal(decision.supportScore.low, 61);
});

test("marks the upper edge of the active bracket as a short watch", () => {
  const decision = build(levels, scorecard, 98);
  assert.equal(decision.status, "short-watch");
  assert.ok(decision.shortRewardRisk > 1);
});

test("keeps the middle of the bracket as wait", () => {
  const decision = build(levels, scorecard, 95);
  assert.equal(decision.status, "wait");
  assert.match(decision.title, /Middle of the range/);
});

test("does not manufacture a setup outside the known level map", () => {
  const decision = build(levels, scorecard, 130);
  assert.equal(decision.status, "wait");
  assert.equal(decision.support, null);
  assert.match(decision.summary, /outside the known level map/);
});

test("requires a completed support touch to close back above the zone", () => {
  const candles = [
    { time: 1, low: 91, high: 95, close: 93 },
    { time: 2, low: 89, high: 94, close: 91 },
    { time: 3, low: 88, high: 93, close: 89 }, // forming: ignored
  ];
  const testResult = recentBoundaryTest(candles, levels[1], "support");
  assert.equal(testResult.touched, true);
  assert.equal(testResult.confirmed, true);
  assert.equal(testResult.time, 2);
});

test("reports a resistance touch without confirmation when it closes above", () => {
  const candles = [
    { time: 1, low: 96, high: 101, close: 101 },
    { time: 2, low: 99, high: 102, close: 101 },
  ];
  const testResult = recentBoundaryTest(candles, levels[2], "resistance");
  assert.equal(testResult.touched, true);
  assert.equal(testResult.confirmed, false);
});

test("patience state becomes ready only after all three facts agree", () => {
  const decision = build(levels, scorecard, 92);
  const candles = [
    { time: 1, low: 89, high: 94, close: 91 },
    { time: 2, low: 91, high: 93, close: 92 }, // forming: ignored
  ];
  const gate = patienceState(decision, candles);
  assert.equal(gate.readyCount, 3);
  assert.equal(gate.isReady, true);
  assert.equal(gate.boundary.name, "VAL (60d)");
  assert.equal(gate.boundaryTest.time, 1);
});

test("patience state refuses a confirmed candle when price is no longer at an edge", () => {
  const decision = build(levels, scorecard, 95);
  const candles = [
    { time: 1, low: 89, high: 96, close: 91 },
    { time: 2, low: 94, high: 96, close: 95 },
  ];
  const gate = patienceState(decision, candles);
  assert.equal(gate.readyCount, 0);
  assert.equal(gate.isReady, false);
  assert.equal(gate.boundaryTest, null);
});

test("alert fingerprint deduplicates one confirmed setup and changes for a new candle", () => {
  const decision = build(levels, scorecard, 92);
  const first = patienceState(decision, [
    { time: 1, low: 89, high: 94, close: 91 },
    { time: 2, low: 91, high: 93, close: 92 },
  ]);
  const second = patienceState(decision, [
    { time: 1, low: 89, high: 94, close: 91 },
    { time: 3, low: 89, high: 94, close: 91 },
    { time: 4, low: 91, high: 93, close: 92 },
  ]);
  assert.equal(patienceAlertFingerprint("btc", "4h", decision, first), "btc|4h|long-watch|VAL (60d)|1");
  assert.equal(patienceAlertFingerprint("btc", "4h", decision, first), patienceAlertFingerprint("btc", "4h", decision, first));
  assert.notEqual(patienceAlertFingerprint("btc", "4h", decision, first), patienceAlertFingerprint("btc", "4h", decision, second));
  assert.equal(patienceAlertFingerprint("btc", "4h", decision, { ...first, isReady: false }), null);
});
