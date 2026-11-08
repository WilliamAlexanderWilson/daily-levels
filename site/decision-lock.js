(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DecisionLock = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function midpoint(level) {
    return level && Number.isFinite(Number(level.price_low)) && Number.isFinite(Number(level.price_high))
      ? (Number(level.price_low) + Number(level.price_high)) / 2
      : null;
  }

  function entryIsCurrent(entry, currentPrice, nowMs, maxAgeMs = 15000) {
    const entryPrice = Number(entry && entry.price);
    const entryTimeMs = Number(entry && entry.time) * 1000;
    const mark = Number(currentPrice);
    const ageMs = Number(nowMs) - entryTimeMs;
    const driftFraction = Number.isFinite(mark) && mark > 0
      ? Math.abs(entryPrice - mark) / mark
      : Infinity;
    return Boolean(
      entry && entry.source === "live"
      && Number.isFinite(entryPrice) && entryPrice > 0
      && Number.isFinite(entryTimeMs)
      && Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= maxAgeMs
      && driftFraction <= 0.0025
    );
  }

  function evaluate({ decision, gate, direction, plan, minRewardRisk = 2, entry, currentPrice, nowMs = Date.now(), markFresh = true }) {
    const expectedDirection = decision && decision.status === "long-watch"
      ? "long"
      : decision && decision.status === "short-watch"
        ? "short"
        : null;
    const support = decision && decision.support;
    const resistance = decision && decision.resistance;
    const supportLow = Number(support && support.price_low);
    const supportHigh = Number(support && support.price_high);
    const resistanceLow = Number(resistance && resistance.price_low);
    const resistanceHigh = Number(resistance && resistance.price_high);
    const hasRange = [supportLow, supportHigh, resistanceLow, resistanceHigh]
      .every((value) => Number.isFinite(value) && value > 0);
    const planValid = Boolean(plan && plan.valid);
    const threshold = Number(minRewardRisk);
    const thresholdValid = Number.isFinite(threshold) && threshold >= 1 && threshold <= 10;
    const usableThreshold = thresholdValid ? threshold : null;
    const stopBeyondInvalidation = planValid && hasRange && direction === "long"
      ? Number(plan.stop) < supportLow
      : planValid && direction === "short"
        ? hasRange && Number(plan.stop) > resistanceHigh
        : false;
    const targetInsideRange = planValid && hasRange && direction === "long"
      ? Number(plan.target) <= resistanceLow
      : planValid && direction === "short"
        ? hasRange && Number(plan.target) >= supportHigh
        : false;
    const currentEntry = entryIsCurrent(entry, currentPrice, nowMs);
    const confirmationReady = Boolean(gate && gate.isReady && markFresh && currentEntry);
    const checks = [
      {
        id: "confirmation",
        passed: confirmationReady,
        label: "Current confirmation and live entry",
        detail: !markFresh
          ? "The live mark is stale or reconnecting. Wait for a fresh stream."
          : !(gate && gate.isReady)
            ? "Wait for all three live checklist conditions; an old or partial setup stays locked."
            : !currentEntry
              ? "Use Open at live price again. Manual, historical, old, or drifted entries stay locked."
              : "Location, boundary test, latest completed close, and this fresh live entry agree.",
      },
      {
        id: "direction",
        passed: Boolean(expectedDirection && direction === expectedDirection),
        label: "Direction matches the confirmed edge",
        detail: !expectedDirection
          ? "The current range read has no eligible direction."
          : direction === expectedDirection
            ? `${expectedDirection === "long" ? "Long" : "Short"} matches the confirmed ${expectedDirection === "long" ? "support" : "resistance"} edge.`
            : `The current range read supports ${expectedDirection}, not ${direction || "an unselected side"}.`,
      },
      {
        id: "stop",
        passed: stopBeyondInvalidation,
        label: "Stop is beyond invalidation",
        detail: !planValid
          ? "Complete a valid risk plan first."
          : stopBeyondInvalidation
            ? `Stop is beyond the ${direction === "long" ? "support low" : "resistance high"}.`
            : !hasRange
              ? "A complete support/resistance map is required."
              : `Move the stop beyond ${direction === "long" ? supportLow.toLocaleString() : resistanceHigh.toLocaleString()} or skip the plan.`,
      },
      {
        id: "target",
        passed: targetInsideRange,
        label: "Target stays inside the mapped range",
        detail: !planValid
          ? "Complete a valid risk plan first."
          : targetInsideRange
            ? "Target does not assume price will break through the opposite boundary."
            : !hasRange
              ? "A complete support/resistance map is required."
              : `Keep the first target at or before ${direction === "long" ? resistanceLow.toLocaleString() : supportHigh.toLocaleString()}.`,
      },
      {
        id: "payoff",
        passed: Boolean(planValid && thresholdValid && Number(plan.rewardRisk) >= usableThreshold),
        label: thresholdValid ? `Meets your ${usableThreshold.toFixed(1)}R minimum` : "Set a valid minimum R",
        detail: !thresholdValid
          ? "Choose your minimum planned R between 1 and 10."
          : !planValid
          ? "Complete a valid risk plan first."
          : Number(plan.rewardRisk) >= usableThreshold
            ? `Planned reward-to-risk is ${Number(plan.rewardRisk).toFixed(2)}R.`
            : `Planned reward-to-risk is ${Number(plan.rewardRisk).toFixed(2)}R; your rule requires ${usableThreshold.toFixed(1)}R.`,
      },
    ];
    const passedCount = checks.filter((check) => check.passed).length;
    const eligible = checks.every((check) => check.passed);
    let status = "wait";
    let title = "WAIT — market confirmation is incomplete";
    if (confirmationReady && (!direction || !planValid)) {
      status = "incomplete";
      title = "BUILD THE PLAN — confirmation is ready, risk is not";
    } else if (confirmationReady && !eligible) {
      status = "revise";
      title = "REVISE — the plan conflicts with your rules";
    } else if (eligible) {
      status = "eligible";
      title = "PAPER-ELIGIBLE — all five rules agree";
    }
    return {
      status,
      title,
      eligible,
      passedCount,
      expectedDirection,
      minRewardRisk: usableThreshold,
      supportMidpoint: midpoint(support),
      resistanceMidpoint: midpoint(resistance),
      checks,
    };
  }

  function evaluateCurrent({
    asset,
    price,
    levels,
    scorecard,
    strategyRange,
    candles,
    direction,
    plan,
    minRewardRisk,
    entry,
    markFresh,
    nowMs = Date.now(),
    rangeDecision,
  }) {
    const decision = asset === "btc"
      ? rangeDecision.buildStrategyRange(price, strategyRange, candles)
      : rangeDecision.build(levels, scorecard, price);
    const gate = rangeDecision.patienceState(decision, candles);
    return {
      ...evaluate({ decision, gate, direction, plan, minRewardRisk, entry, currentPrice: price, nowMs, markFresh }),
      decision,
      gate,
    };
  }

  return { evaluate, evaluateCurrent, entryIsCurrent };
});
