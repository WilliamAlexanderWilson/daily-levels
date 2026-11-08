(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.RangeDecision = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  // The transcript says to trade from the edges of a range, but never
  // defines an objective entry threshold. We make that missing assumption
  // explicit: the outer 35% on either side is a watch area and the middle
  // 30% is a no-trade area. This is a geometry filter, not a claim of edge.
  const EDGE_FRACTION = 0.35;
  const STRUCTURAL_RECLAIM_METHOD = "structural-reclaim-pivot-cluster-v1";

  // This is an explicitly sourced market-structure framework, not a value
  // derived from the daily rolling-level engine. Keeping it as data makes the
  // distinction visible to the UI and easy to replace when the creator
  // publishes a materially different range.
  const BTC_MACRO_RANGE = Object.freeze({
    low: 60000,
    high: 80000,
    reclaim: 82800,
    supportLow: 72000,
    supportHigh: 77000,
    failureLevel: 74000,
    longWatchHigh: 62000,
    sourceDate: "2026-11-04",
    sourceLabel: "Sourced macro-range framework",
    sourceUrl: "#range-method-sources",
  });

  function structuralRegimeIsUsable(regime, fallback = BTC_MACRO_RANGE) {
    const boundary = regime && regime.boundary;
    const exactPrice = boundary && Number(boundary.exact_price);
    const acceptance = regime && regime.acceptance;
    const allowedAcceptance = new Set(["accepted-above", "accepted-below", "testing", "insufficient-data"]);
    return Boolean(
      regime
      && regime.method_version === STRUCTURAL_RECLAIM_METHOD
      && regime.quality === "established"
      && typeof regime.data_source === "string" && regime.data_source.length > 0
      && Number.isFinite(Date.parse(regime.calculated_at_utc))
      && Number.isFinite(exactPrice) && exactPrice > fallback.high
      && Number.isFinite(Number(boundary.display_price))
      && typeof boundary.origin_date === "string" && Number.isFinite(Date.parse(boundary.origin_date))
      && typeof boundary.last_test_date === "string" && Number.isFinite(Date.parse(boundary.last_test_date))
      && Number(boundary.pivot_count) >= 4
      && Number(boundary.distinct_months) >= 3
      && Number(boundary.span_days) >= 90
      && Array.isArray(boundary.tests) && boundary.tests.length >= Number(boundary.pivot_count)
      && acceptance && allowedAcceptance.has(acceptance.state)
      && typeof acceptance.rule === "string" && acceptance.rule.length > 0
      && Array.isArray(acceptance.closes)
    );
  }

  function strategyRangeFromRegime(regime, fallback = BTC_MACRO_RANGE) {
    if (!structuralRegimeIsUsable(regime, fallback)) return fallback;
    const boundary = regime.boundary;
    const exactPrice = Number(boundary.exact_price);

    return Object.freeze({
      ...fallback,
      reclaim: exactPrice,
      reclaimDisplay: Number(boundary.display_price) || exactPrice,
      reclaimOriginDate: boundary.origin_date || null,
      reclaimLastTestDate: boundary.last_test_date || null,
      reclaimPivotCount: Number(boundary.pivot_count) || 0,
      reclaimDistinctMonths: Number(boundary.distinct_months) || 0,
      reclaimQuality: regime.quality || "developing",
      reclaimAcceptance: regime.acceptance || null,
      reclaimMethodVersion: regime.method_version || null,
      reclaimCalculatedAt: regime.calculated_at_utc || null,
      reclaimDataSource: regime.data_source || null,
      sourceLabel: "Calculated structural reclaim with dated source framework",
      isCalculatedReclaim: true,
    });
  }

  function reclaimBiasPresentation(range, currentPrice) {
    const price = range && Number(range.reclaim);
    const priceText = Number.isFinite(price)
      ? price.toLocaleString(undefined, { maximumFractionDigits: 0 })
      : "unavailable";
    if (!range || !range.isCalculatedReclaim) {
      return {
        label: `DATED SOURCE · ${priceText}`,
        note: "Calculated Daily acceptance unavailable; dated fallback only",
      };
    }
    const acceptance = range.reclaimAcceptance;
    const rule = acceptance && acceptance.rule
      ? `${acceptance.rule} · descriptive, not a trade instruction`
      : "Calculated Daily acceptance unavailable";
    if (acceptance && acceptance.state === "accepted-above") {
      return { label: `DAILY ACCEPTED > ${priceText}`, note: rule };
    }
    if (acceptance && acceptance.state === "accepted-below") {
      return { label: `DAILY BELOW < ${priceText}`, note: rule };
    }
    if (acceptance && acceptance.state === "testing") {
      return { label: `DAILY TESTING ${priceText}`, note: rule };
    }
    if (acceptance && acceptance.state === "insufficient-data") {
      return { label: "DAILY DATA INCOMPLETE", note: rule };
    }
    return {
      label: Number.isFinite(currentPrice) ? `STATUS UNAVAILABLE · ${priceText}` : "STATUS UNAVAILABLE",
      note: "Calculated Daily acceptance unavailable",
    };
  }

  function midpoint(level) {
    return (level.price_low + level.price_high) / 2;
  }

  function nearestBracket(levels, price) {
    let support = null;
    let resistance = null;
    for (const level of levels || []) {
      const mid = midpoint(level);
      if (mid < price && (!support || mid > midpoint(support))) support = level;
      if (mid > price && (!resistance || mid < midpoint(resistance))) resistance = level;
    }
    return { support, resistance };
  }

  function scoreForLevel(level, scorecard) {
    if (!level || !scorecard) return null;
    const entries = level.name
      .split(" + ")
      .map((name) => scorecard[name])
      .filter((entry) => entry && Number.isFinite(entry.hold_rate_pct));
    if (!entries.length) return null;
    return {
      low: Math.min(...entries.map((entry) => entry.hold_rate_pct)),
      high: Math.max(...entries.map((entry) => entry.hold_rate_pct)),
      resolved: entries.reduce((sum, entry) => sum + (entry.resolved || 0), 0),
      lowConfidence: entries.some((entry) => entry.low_confidence),
    };
  }

  function findRangeEdge(levels, side) {
    const token = side === "low" ? "Range low" : "Range high";
    return (levels || []).find((level) => level.name.split(" + ").some((name) => name.startsWith(token))) || null;
  }

  function recentBoundaryTest(candles, level, side, lookbackBars = 20) {
    if (!Array.isArray(candles) || candles.length < 2 || !level) return null;
    // Kraken's last row is the still-forming candle. Exclude it so the UI
    // never calls an unfinished wick/close a confirmed rejection.
    const completed = candles.slice(0, -1);
    const start = Math.max(0, completed.length - lookbackBars);
    for (let index = completed.length - 1; index >= start; index -= 1) {
      const candle = completed[index];
      if (![candle.low, candle.high, candle.close].every(Number.isFinite)) continue;
      const touched = candle.low <= level.price_high && candle.high >= level.price_low;
      if (!touched) continue;
      const confirmed = side === "support"
        ? candle.close > level.price_high
        : candle.close < level.price_low;
      return {
        touched: true,
        confirmed,
        time: candle.time,
        barsAgo: completed.length - 1 - index,
        close: candle.close,
      };
    }
    return { touched: false, confirmed: false, time: null, barsAgo: null, close: null };
  }

  function latestCompletedCandle(candles) {
    if (!Array.isArray(candles) || candles.length < 2) return null;
    return candles[candles.length - 2] || null;
  }

  function completedCloseAbove(candles, price) {
    const candle = latestCompletedCandle(candles);
    return Boolean(candle && Number.isFinite(candle.close) && candle.close > price);
  }

  function strategyTrackPosition(decision, price) {
    const range = decision && decision.strategyRange;
    if (!range || !Number.isFinite(price) || !(range.reclaim > range.low)) return null;
    return Math.max(0, Math.min(1, (price - range.low) / (range.reclaim - range.low)));
  }

  function patienceState(decision, candles) {
    const hasLocation = decision && (decision.status === "long-watch" || decision.status === "short-watch");
    const boundary = hasLocation
      ? (decision.status === "long-watch" ? decision.support : decision.resistance)
      : null;
    const side = decision && decision.status === "long-watch" ? "support" : "resistance";
    const boundaryTest = hasLocation && boundary
      ? recentBoundaryTest(candles, boundary, side)
      : null;
    const hasTouch = Boolean(boundaryTest && boundaryTest.touched);
    // A confirmation is actionable context only on the latest completed
    // candle. Keeping an older reclaim "ready" after price wanders back to
    // the edge would turn stale history into a seemingly live suggestion.
    const hasConfirmation = Boolean(
      boundaryTest && boundaryTest.confirmed && boundaryTest.barsAgo === 0
    );
    const readyCount = [hasLocation, hasTouch, hasConfirmation].filter(Boolean).length;
    return {
      hasLocation,
      hasTouch,
      hasConfirmation,
      isReady: readyCount === 3,
      readyCount,
      boundary,
      side,
      boundaryTest,
    };
  }

  function confirmedSetup(decision, candles) {
    const gate = patienceState(decision, candles);
    if (!gate.isReady || !gate.boundaryTest || gate.boundaryTest.barsAgo !== 0) return null;
    const direction = decision.status === "long-watch" ? "long" : "short";
    return {
      direction,
      time: gate.boundaryTest.time,
      close: gate.boundaryTest.close,
      boundaryName: gate.boundary.name,
      label: `${direction.toUpperCase()} SETUP ✓`,
    };
  }

  function patienceAlertFingerprint(asset, range, decision, gateState) {
    if (!asset || !range || !decision || !gateState || !gateState.isReady || !gateState.boundaryTest) return null;
    return [
      asset,
      range,
      decision.status,
      gateState.boundary.name,
      gateState.boundaryTest.time,
    ].join("|");
  }

  function rangeZonePrices(decision) {
    if (decision && decision.strategyRange) {
      const range = decision.strategyRange;
      return {
        low: range.low,
        longThreshold: range.longWatchHigh,
        shortThreshold: range.high,
        high: range.reclaim,
        supportLow: range.supportLow,
        supportHigh: range.supportHigh,
        failureLevel: range.failureLevel,
        segments: [
          { low: range.high, high: range.reclaim, kind: "short", label: "SHORT WATCH · UPPER DEVIATION" },
          { low: range.supportHigh, high: range.high, kind: "wait", label: "WAIT" },
          { low: range.supportLow, high: range.supportHigh, kind: "long", label: "LONG WATCH · DECISION SUPPORT" },
          { low: range.longWatchHigh, high: range.supportLow, kind: "wait", label: "WAIT" },
          { low: range.low, high: range.longWatchHigh, kind: "long", label: "LONG WATCH · RANGE FLOOR" },
        ],
      };
    }
    if (!decision || !decision.support || !decision.resistance) return null;
    const low = midpoint(decision.support);
    const high = midpoint(decision.resistance);
    if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) return null;
    const span = high - low;
    return {
      low,
      longThreshold: low + span * EDGE_FRACTION,
      shortThreshold: low + span * (1 - EDGE_FRACTION),
      high,
    };
  }

  function emptyDecision(reason) {
    return {
      status: "wait",
      label: "WAIT",
      title: "No complete range yet",
      summary: reason,
      support: null,
      resistance: null,
      bracketPosition: null,
      macroPosition: null,
      longRewardRisk: null,
      shortRewardRisk: null,
      preferredRewardRisk: null,
      supportScore: null,
      resistanceScore: null,
      strategyRange: null,
    };
  }

  function syntheticLevel(name, priceLow, priceHigh, type) {
    return {
      name,
      price_low: priceLow,
      price_high: priceHigh,
      type,
      strength: 0,
      is_flip: false,
    };
  }

  function buildStrategyRange(price, range = BTC_MACRO_RANGE, candles = []) {
    if (!Number.isFinite(price) || !range || !(range.high > range.low) || !(range.reclaim >= range.high)) {
      return emptyDecision("The sourced macro-range framework is unavailable. Do not substitute a nearby level bracket.");
    }

    const span = range.high - range.low;
    const macroPosition = (price - range.low) / span;
    const floor = syntheticLevel("Macro range floor", range.low, range.low, "support");
    const support = syntheticLevel("Decision support", range.supportLow, range.supportHigh, "support");
    const resistance = syntheticLevel("Range high + reclaim", range.high, range.reclaim, "resistance");

    let status = "wait";
    let label = "WAIT";
    let title = "Inside the macro range — no edge from location alone";
    let summary = "Let price reach a defined decision area. Nearby levels are context, not a reason to manufacture a trade.";
    let confirmationSupport = support;

    const supportTest = recentBoundaryTest(candles, support, "support");
    const resistanceTest = recentBoundaryTest(candles, resistance, "resistance");
    const recentSupportConfirmation = Boolean(supportTest && supportTest.confirmed && supportTest.barsAgo === 0);
    const recentResistanceConfirmation = Boolean(resistanceTest && resistanceTest.confirmed && resistanceTest.barsAgo === 0);

    if (recentSupportConfirmation && recentResistanceConfirmation) {
      status = "wait";
      label = "WAIT";
      title = "Conflicting boundary candle — no directional edge";
      summary = "The most recent completed candle crossed both decision support and the upper deviation. Do not let one unusually wide candle manufacture both a long and a short setup.";
    } else if (recentSupportConfirmation && price > range.supportHigh && price < range.high) {
      status = "long-watch";
      label = "LONG WATCH";
      title = "Support reclaim confirmed — assess, do not chase";
      summary = `The most recent completed candle tested ${range.supportLow.toLocaleString()}–${range.supportHigh.toLocaleString()} support and closed back above it. The Patience gate can now complete; risk and size remain separate decisions.`;
    } else if (recentResistanceConfirmation && price < range.high && price > range.supportHigh) {
      status = "short-watch";
      label = "SHORT WATCH";
      title = "Upper rejection confirmed — assess, do not chase";
      summary = `The most recent completed candle tested the ${range.high.toLocaleString()}–${range.reclaim.toLocaleString()} deviation and closed back below it. The Patience gate can now complete; risk and size remain separate decisions.`;
    } else if (price >= range.supportLow && price <= range.supportHigh) {
      status = "long-watch";
      label = "LONG WATCH";
      title = "Support decision zone — wait for the reclaim";
      summary = `Price is inside ${range.supportLow.toLocaleString()}–${range.supportHigh.toLocaleString()} support. A sweep and completed close back above the zone is the confirmation gate; a touch is not an entry.`;
    } else if (price >= range.high && price <= range.reclaim) {
      status = "short-watch";
      label = "SHORT WATCH";
      title = "Upper deviation — rejection must confirm";
      summary = `Price is testing the ${range.high.toLocaleString()} range ceiling through the ${range.reclaim.toLocaleString()} reclaim level. Wait for a completed close back below the zone before assessing a short.`;
    } else if (price >= range.low && price <= range.longWatchHigh) {
      status = "long-watch";
      label = "LONG WATCH";
      title = "Macro range floor — only a reclaim confirms";
      summary = `Price is near the ${range.low.toLocaleString()} macro floor. Treat a sweep below and completed reclaim as evidence; do not catch a falling candle.`;
      confirmationSupport = floor;
    } else if (price > range.reclaim) {
      title = "Above the bearish reclaim threshold";
      summary = `Price is above ${range.reclaim.toLocaleString()}. The prior lower-bias framework needs fresh acceptance evidence before it can be reused.`;
    } else if (price < range.low) {
      title = "Below the macro range — framework invalidated";
      summary = `Price is below the ${range.low.toLocaleString()} floor. Wait for a new range or a confirmed reclaim instead of treating the old floor as automatic support.`;
    } else if (price < range.supportLow) {
      title = "Lower half of the macro range — patience over prediction";
      summary = `Price is below the decision-support zone but above the ${range.low.toLocaleString()} floor. The next clean location is the floor or a reclaim of ${range.supportLow.toLocaleString()}–${range.supportHigh.toLocaleString()}.`;
    } else {
      title = "Between support and the range ceiling — wait";
      summary = `Price is above ${range.supportHigh.toLocaleString()} support but below the ${range.high.toLocaleString()} ceiling. This is not a clean range edge.`;
    }

    return {
      status,
      label,
      title,
      summary,
      support: confirmationSupport,
      resistance,
      bracketPosition: Math.max(0, Math.min(1, macroPosition)),
      macroPosition,
      longRewardRisk: null,
      shortRewardRisk: null,
      preferredRewardRisk: null,
      supportScore: null,
      resistanceScore: null,
      strategyRange: range,
    };
  }

  function build(levels, scorecard, price) {
    if (!Number.isFinite(price) || !Array.isArray(levels) || !levels.length) {
      return emptyDecision("Price or level data is unavailable. Do not infer a setup from a partial chart.");
    }

    const { support, resistance } = nearestBracket(levels, price);
    if (!support || !resistance) {
      return emptyDecision("Price is outside the known level map. Wait for a fresh bracket instead of chasing beyond the range.");
    }

    const supportPrice = midpoint(support);
    const resistancePrice = midpoint(resistance);
    const span = resistancePrice - supportPrice;
    if (!(span > 0)) return emptyDecision("The nearest support and resistance do not form a usable range.");

    const bracketPosition = Math.max(0, Math.min(1, (price - supportPrice) / span));
    const downside = price - supportPrice;
    const upside = resistancePrice - price;
    const longRewardRisk = downside > 0 ? upside / downside : null;
    const shortRewardRisk = upside > 0 ? downside / upside : null;

    let status = "wait";
    let label = "WAIT";
    let title = "Middle of the range — no edge from location";
    let summary = "Price is not close enough to either boundary. Let it come to you instead of forcing a trade in the middle.";
    let preferredRewardRisk = Math.max(longRewardRisk || 0, shortRewardRisk || 0);

    if (bracketPosition <= EDGE_FRACTION) {
      status = "long-watch";
      label = "LONG WATCH";
      title = "Near support — long side has cleaner range geometry";
      summary = `Watch for ${support.name} to hold or be reclaimed. Location alone is not confirmation.`;
      preferredRewardRisk = longRewardRisk;
    } else if (bracketPosition >= 1 - EDGE_FRACTION) {
      status = "short-watch";
      label = "SHORT WATCH";
      title = "Near resistance — short side has cleaner range geometry";
      summary = `Watch for rejection at ${resistance.name}. Location alone is not confirmation.`;
      preferredRewardRisk = shortRewardRisk;
    }

    const rangeLow = findRangeEdge(levels, "low");
    const rangeHigh = findRangeEdge(levels, "high");
    let macroPosition = null;
    if (rangeLow && rangeHigh) {
      const low = midpoint(rangeLow);
      const high = midpoint(rangeHigh);
      if (high > low) macroPosition = Math.max(0, Math.min(1, (price - low) / (high - low)));
    }

    return {
      status,
      label,
      title,
      summary,
      support,
      resistance,
      bracketPosition,
      macroPosition,
      longRewardRisk,
      shortRewardRisk,
      preferredRewardRisk,
      supportScore: scoreForLevel(support, scorecard),
      resistanceScore: scoreForLevel(resistance, scorecard),
    };
  }

  return {
    EDGE_FRACTION,
    build,
    midpoint,
    nearestBracket,
    scoreForLevel,
    recentBoundaryTest,
    latestCompletedCandle,
    completedCloseAbove,
    strategyTrackPosition,
    patienceState,
    confirmedSetup,
    patienceAlertFingerprint,
    rangeZonePrices,
    buildStrategyRange,
    BTC_MACRO_RANGE,
    STRUCTURAL_RECLAIM_METHOD,
    structuralRegimeIsUsable,
    strategyRangeFromRegime,
    reclaimBiasPresentation,
  };
});
