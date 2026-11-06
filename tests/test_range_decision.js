const test = require("node:test");
const assert = require("node:assert/strict");
const { build } = require("../site/range-decision.js");

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
