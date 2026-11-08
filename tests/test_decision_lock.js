const test = require("node:test");
const assert = require("node:assert/strict");
const DecisionLock = require("../site/decision-lock.js");

const decision = {
  status: "long-watch",
  support: { price_low: 72, price_high: 77 },
  resistance: { price_low: 80, price_high: 82.8 },
};
const validPlan = { valid: true, entry: 77.5, stop: 71, target: 79, rewardRisk: 2.5 };
const freshEntry = { source: "live", time: 100, price: 77.5 };
const current = { entry: freshEntry, currentPrice: 77.5, nowMs: 100000, markFresh: true };

test("keeps the plan locked until the current three-part gate is ready", () => {
  const result = DecisionLock.evaluate({ decision, gate: { isReady: false }, direction: "long", plan: validPlan, ...current });
  assert.equal(result.status, "wait");
  assert.equal(result.eligible, false);
  assert.equal(result.passedCount, 4);
});

test("requires direction, invalidation, target, and user R rule to agree", () => {
  assert.equal(DecisionLock.evaluate({ decision, gate: { isReady: true }, direction: "short", plan: validPlan, ...current }).eligible, false);
  assert.equal(DecisionLock.evaluate({ decision, gate: { isReady: true }, direction: "long", plan: { ...validPlan, stop: 73 }, ...current }).eligible, false);
  assert.equal(DecisionLock.evaluate({ decision, gate: { isReady: true }, direction: "long", plan: { ...validPlan, target: 81 }, ...current }).eligible, false);
  assert.equal(DecisionLock.evaluate({ decision, gate: { isReady: true }, direction: "long", plan: { ...validPlan, rewardRisk: 1.9 }, ...current }).eligible, false);
});

test("marks a confirmed range-aligned plan paper-eligible without calling it a trade signal", () => {
  const result = DecisionLock.evaluate({ decision, gate: { isReady: true }, direction: "long", plan: validPlan, minRewardRisk: 2, ...current });
  assert.equal(result.status, "eligible");
  assert.equal(result.eligible, true);
  assert.equal(result.passedCount, 5);
});

test("applies the mirrored rules to a short at resistance", () => {
  const shortDecision = { ...decision, status: "short-watch" };
  const result = DecisionLock.evaluate({
    decision: shortDecision,
    gate: { isReady: true },
    direction: "short",
    plan: { valid: true, entry: 79.5, stop: 83, target: 78, rewardRisk: 2.2 },
    entry: { source: "live", time: 100, price: 79.5 },
    currentPrice: 79.5,
    nowMs: 100000,
    markFresh: true,
  });
  assert.equal(result.eligible, true);
});

test("never treats a missing range map as a valid stop or target", () => {
  const result = DecisionLock.evaluate({
    decision: { status: "long-watch", support: null, resistance: null },
    gate: { isReady: true },
    direction: "long",
    plan: validPlan,
    ...current,
  });
  assert.equal(result.eligible, false);
  assert.equal(result.checks.find((check) => check.id === "stop").passed, false);
  assert.equal(result.checks.find((check) => check.id === "target").passed, false);
});

test("clearing the user's minimum R does not silently restore a default", () => {
  const result = DecisionLock.evaluate({
    decision,
    gate: { isReady: true },
    direction: "long",
    plan: validPlan,
    minRewardRisk: Number.NaN,
    ...current,
  });
  assert.equal(result.eligible, false);
  assert.equal(result.checks.find((check) => check.id === "payoff").label, "Set a valid minimum R");
});

test("locks manual, historical, stale, and materially drifted entries", () => {
  const base = { decision, gate: { isReady: true }, direction: "long", plan: validPlan, currentPrice: 77.5, nowMs: 100000, markFresh: true };
  assert.equal(DecisionLock.evaluate({ ...base, entry: { source: "manual", time: 100, price: 60 } }).eligible, false);
  assert.equal(DecisionLock.evaluate({ ...base, entry: { source: "chart", time: 100, price: 77.5 } }).eligible, false);
  assert.equal(DecisionLock.evaluate({ ...base, entry: { source: "live", time: 80, price: 77.5 } }).eligible, false);
  assert.equal(DecisionLock.evaluate({ ...base, entry: { source: "live", time: 100, price: 76 } }).eligible, false);
  assert.equal(DecisionLock.evaluate({ ...base, entry: freshEntry, markFresh: false }).eligible, false);

  const shortBase = {
    decision: { ...decision, status: "short-watch" },
    gate: { isReady: true },
    direction: "short",
    plan: { valid: true, entry: 90, stop: 91, target: 80, rewardRisk: 10 },
    currentPrice: 79.5,
    nowMs: 100000,
    markFresh: true,
  };
  assert.equal(DecisionLock.evaluate({ ...shortBase, entry: { source: "manual", time: 100, price: 90 } }).eligible, false);
});

test("rebuilds the decision and gate from the newest tick before eligibility", () => {
  const fakeRangeDecision = {
    buildStrategyRange(price) {
      return { ...decision, status: price === 77.5 ? "long-watch" : "wait" };
    },
    build() { return decision; },
    patienceState(nextDecision) {
      return { isReady: nextDecision.status === "long-watch" };
    },
  };
  const base = {
    asset: "btc", levels: [], scorecard: {}, strategyRange: {}, candles: [],
    direction: "long", plan: validPlan, minRewardRisk: 2, entry: freshEntry,
    markFresh: true, nowMs: 100000, rangeDecision: fakeRangeDecision,
  };
  assert.equal(DecisionLock.evaluateCurrent({ ...base, price: 77.5 }).eligible, true);
  assert.equal(DecisionLock.evaluateCurrent({ ...base, price: 78 }).eligible, false);
});
