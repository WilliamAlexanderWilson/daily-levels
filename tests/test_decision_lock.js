const test = require("node:test");
const assert = require("node:assert/strict");
const DecisionLock = require("../site/decision-lock.js");

const decision = {
  status: "long-watch",
  support: { price_low: 72, price_high: 77 },
  resistance: { price_low: 80, price_high: 82.8 },
};
const validPlan = { valid: true, stop: 71, target: 79, rewardRisk: 2.5 };

test("keeps the plan locked until the current three-part gate is ready", () => {
  const result = DecisionLock.evaluate({ decision, gate: { isReady: false }, direction: "long", plan: validPlan });
  assert.equal(result.status, "wait");
  assert.equal(result.eligible, false);
  assert.equal(result.passedCount, 4);
});

test("requires direction, invalidation, target, and user R rule to agree", () => {
  assert.equal(DecisionLock.evaluate({ decision, gate: { isReady: true }, direction: "short", plan: validPlan }).eligible, false);
  assert.equal(DecisionLock.evaluate({ decision, gate: { isReady: true }, direction: "long", plan: { ...validPlan, stop: 73 } }).eligible, false);
  assert.equal(DecisionLock.evaluate({ decision, gate: { isReady: true }, direction: "long", plan: { ...validPlan, target: 81 } }).eligible, false);
  assert.equal(DecisionLock.evaluate({ decision, gate: { isReady: true }, direction: "long", plan: { ...validPlan, rewardRisk: 1.9 } }).eligible, false);
});

test("marks a confirmed range-aligned plan paper-eligible without calling it a trade signal", () => {
  const result = DecisionLock.evaluate({ decision, gate: { isReady: true }, direction: "long", plan: validPlan, minRewardRisk: 2 });
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
    plan: { valid: true, stop: 83, target: 78, rewardRisk: 2.2 },
  });
  assert.equal(result.eligible, true);
});

test("never treats a missing range map as a valid stop or target", () => {
  const result = DecisionLock.evaluate({
    decision: { status: "long-watch", support: null, resistance: null },
    gate: { isReady: true },
    direction: "long",
    plan: validPlan,
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
  });
  assert.equal(result.eligible, false);
  assert.equal(result.checks.find((check) => check.id === "payoff").label, "Set a valid minimum R");
});
