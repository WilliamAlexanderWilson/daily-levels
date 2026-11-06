(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.RangeLab = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  function candidateByKey(data, key) {
    return data && Array.isArray(data.candidates)
      ? data.candidates.find((candidate) => candidate.spec.key === key) || null
      : null;
  }

  function defaultKey(data) {
    if (!data || !Array.isArray(data.candidates) || !data.candidates.length) return null;
    return data.selected_key
      || (candidateByKey(data, "structure") && "structure")
      || data.validation_leader_key
      || data.candidates[0].spec.key;
  }

  function metric(value, suffix = "") {
    return Number.isFinite(value) ? `${value > 0 ? "+" : ""}${value}${suffix}` : "—";
  }

  function viewModel(data, key) {
    const candidate = candidateByKey(data, key || defaultKey(data));
    if (!candidate) return null;
    const holdout = candidate.metrics.holdout;
    const paper = candidate.forward_paper || {
      metrics: { trades: 0, expectancy_pct: null, profit_factor: null, profit_factor_infinite: false },
      open_trade: null,
      pending_entry: null,
    };
    const exitComparison = candidate.exit_comparison || null;
    const walkForward = candidate.walk_forward || null;
    let paperStatus = "Waiting for a completed 4H rejection";
    if (paper.pending_entry) {
      paperStatus = `Pending ${paper.pending_entry.direction} entry · next 4H open`;
    } else if (paper.open_trade) {
      paperStatus = `Open ${paper.open_trade.direction} observation · ${paper.open_trade.bars_observed}/${paper.open_trade.max_hold_bars} bars`;
    }
    return {
      key: candidate.spec.key,
      label: candidate.spec.label,
      method: candidate.spec.method,
      range: candidate.latest_range,
      holdout,
      expectancy: metric(holdout.expectancy_pct, "% / trade"),
      totalReturn: metric(holdout.total_return_pct, "%"),
      profitFactor: holdout.profit_factor_infinite
        ? "∞"
        : Number.isFinite(holdout.profit_factor) ? holdout.profit_factor.toFixed(2) : "—",
      paper,
      paperExpectancy: metric(paper.metrics.expectancy_pct, "% / trade"),
      paperProfitFactor: paper.metrics.profit_factor_infinite
        ? "∞"
        : Number.isFinite(paper.metrics.profit_factor) ? paper.metrics.profit_factor.toFixed(2) : "—",
      paperStatus,
      exitComparison: exitComparison ? {
        baselineValidation: metric(exitComparison.baseline.validation.expectancy_pct, "% / trade"),
        runnerValidation: metric(exitComparison.runner.validation.expectancy_pct, "% / trade"),
        baselineHoldout: metric(exitComparison.baseline.holdout.expectancy_pct, "% / trade"),
        runnerHoldout: metric(exitComparison.runner.holdout.expectancy_pct, "% / trade"),
        runnerHoldoutTrades: exitComparison.runner.holdout.trades,
        runnerHoldoutProfitFactor: exitComparison.runner.holdout.profit_factor_infinite
          ? "∞"
          : Number.isFinite(exitComparison.runner.holdout.profit_factor)
            ? exitComparison.runner.holdout.profit_factor.toFixed(2)
            : "—",
        validationEligible: Number.isFinite(exitComparison.runner.validation.expectancy_pct)
          && exitComparison.runner.validation.trades >= 20
          && exitComparison.runner.validation.expectancy_pct > 0
          && (exitComparison.runner.validation.profit_factor_infinite
            || exitComparison.runner.validation.profit_factor > 1),
      } : null,
      walkForward: walkForward ? {
        stable: Boolean(walkForward.stable),
        status: walkForward.status,
        eligibleWindows: walkForward.eligible_windows,
        positiveWindows: walkForward.positive_windows,
        positiveShare: `${walkForward.positive_share_pct}%`,
        aggregateTrades: walkForward.aggregate.trades,
        aggregateExpectancy: metric(walkForward.aggregate.expectancy_pct, "% / trade"),
        aggregateProfitFactor: walkForward.aggregate.profit_factor_infinite
          ? "∞"
          : Number.isFinite(walkForward.aggregate.profit_factor)
            ? walkForward.aggregate.profit_factor.toFixed(2)
            : "—",
        aggregateDrawdown: Number.isFinite(walkForward.aggregate.max_drawdown_pct)
          ? `${walkForward.aggregate.max_drawdown_pct}%`
          : "—",
        windows: walkForward.windows.map((window) => ({
          label: window.label,
          regime: window.regime,
          marketReturn: metric(window.market_return_pct, "% BTC"),
          trades: window.metrics.trades,
          expectancy: metric(window.metrics.expectancy_pct, "% / trade"),
          profitFactor: window.metrics.profit_factor_infinite
            ? "∞"
            : Number.isFinite(window.metrics.profit_factor)
              ? window.metrics.profit_factor.toFixed(2)
              : "—",
          sampleEligible: Boolean(window.sample_eligible),
          positive: Boolean(window.positive),
        })),
      } : null,
      passed: Boolean(data.holdout_passed && data.selected_key === candidate.spec.key),
    };
  }

  function freshness(data, nowMs = Date.now()) {
    const updatedMs = Date.parse(data && (data.current_range_data_through || data.generated_at));
    if (!Number.isFinite(updatedMs)) return { stale: true, ageHours: null, label: "update time unavailable" };
    const ageHours = Math.max(0, (nowMs - updatedMs) / 3_600_000);
    return {
      stale: ageHours > 12,
      ageHours,
      label: ageHours < 1 ? "updated within the hour" : `updated ${Math.floor(ageHours)}h ago`,
    };
  }

  function researchCutoff(data) {
    const value = data && data.research_metrics_through;
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : "unknown";
  }

  function forwardStart(data) {
    const value = data && data.forward_tracking && data.forward_tracking.frozen_at;
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : "not started";
  }

  function reconciliationView(data) {
    const reconciliation = data && data.spot_futures_reconciliation;
    const fields = reconciliation && reconciliation.field_basis;
    if (!reconciliation || !fields || !fields.open || !fields.high || !fields.low || !fields.close) return null;
    const close = fields.close;
    const totalMissing = reconciliation.missing_in_spot + reconciliation.missing_in_futures;
    return {
      overlap: `${reconciliation.overlap_candles} aligned 4H candles`,
      missing: `${totalMissing} missing timestamp${totalMissing === 1 ? "" : "s"}`,
      signedCloseBasis: metric(close.mean_signed_pct, "% mean futures basis"),
      p95CloseBasis: `${close.p95_abs_pct}% p95 absolute close difference`,
      p95OhlcBasis: `p95 abs O/H/L/C ${fields.open.p95_abs_pct}% / ${fields.high.p95_abs_pct}% / ${fields.low.p95_abs_pct}% / ${fields.close.p95_abs_pct}%`,
      directionAgreement: `${reconciliation.candle_direction_agreement_pct}% candle-direction agreement`,
      start: reconciliation.comparison_start.slice(0, 10),
      end: reconciliation.comparison_end.slice(0, 10),
    };
  }

  return {
    candidateByKey,
    defaultKey,
    forwardStart,
    freshness,
    metric,
    reconciliationView,
    researchCutoff,
    viewModel,
  };
});
