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
    const hasConfirmation = Boolean(boundaryTest && boundaryTest.confirmed);
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
    patienceState,
    patienceAlertFingerprint,
  };
});
