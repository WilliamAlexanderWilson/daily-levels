const assert = require("node:assert/strict");
const RangeLab = require("../site/range-lab.js");

const data = {
  generated_at: "2026-11-06T04:00:00Z",
  current_range_data_through: "2026-11-06T04:00:00Z",
  research_metrics_through: "2026-11-06T04:00:00Z",
  forward_tracking: { frozen_at: "2026-11-06T04:00:00Z" },
  spot_futures_reconciliation: {
    comparison_start: "2026-07-10T00:00:00Z",
    comparison_end: "2026-11-06T12:00:00Z",
    overlap_candles: 719,
    missing_in_spot: 0,
    missing_in_futures: 0,
    candle_direction_agreement_pct: 95.2,
    field_basis: {
      open: { p95_abs_pct: 0.18 },
      high: { p95_abs_pct: 0.31 },
      low: { p95_abs_pct: 0.29 },
      close: { mean_signed_pct: 0.08, p95_abs_pct: 0.21 },
    },
  },
  selected_key: null,
  validation_leader_key: "fixed",
  holdout_passed: false,
  candidates: [
    {
      spec: { key: "fixed", label: "$2k–$4k", method: "fixed_usd" },
      latest_range: { low: 70000, high: 74000, active_now: false },
      metrics: { holdout: { trades: 12, expectancy_pct: -0.2, total_return_pct: -2.4, profit_factor: 0.8 } },
      forward_paper: {
        metrics: { trades: 1, expectancy_pct: 0.5, profit_factor: null, profit_factor_infinite: true },
        open_trade: { direction: "long", bars_observed: 3, max_hold_bars: 80 },
        pending_entry: null,
      },
      exit_comparison: {
        baseline: {
          validation: { trades: 25, expectancy_pct: -0.8 },
          holdout: { trades: 30, expectancy_pct: -0.4 },
        },
        runner: {
          validation: { trades: 22, expectancy_pct: -0.2, profit_factor: 0.9, profit_factor_infinite: false },
          holdout: { trades: 24, expectancy_pct: 0.5, profit_factor: 1.3, profit_factor_infinite: false },
        },
      },
      walk_forward: {
        stable: false,
        status: "did not pass the frozen historical stability screen",
        eligible_windows: 2,
        positive_windows: 1,
        positive_share_pct: 50,
        aggregate: {
          trades: 39,
          expectancy_pct: -1.0132,
          profit_factor: 0.327,
          profit_factor_infinite: false,
          max_drawdown_pct: 33.19,
        },
        windows: [
          {
            label: "2023 H1",
            regime: "bull",
            market_return_pct: 84.49,
            sample_eligible: false,
            positive: false,
            metrics: { trades: 2, expectancy_pct: -2.6766, profit_factor: 0, profit_factor_infinite: false },
          },
          {
            label: "2023 H2",
            regime: "bull",
            market_return_pct: 39.09,
            sample_eligible: true,
            positive: true,
            metrics: { trades: 11, expectancy_pct: 0.085, profit_factor: 1.1, profit_factor_infinite: false },
          },
        ],
      },
    },
    {
      spec: { key: "structure", label: "Structure range", method: "structure" },
      latest_range: { low: 68000, high: 76000, active_now: true },
      metrics: { holdout: { trades: 30, expectancy_pct: 0.1, total_return_pct: 3.1, profit_factor: 1.1 } },
    },
  ],
};

assert.equal(RangeLab.defaultKey(data), "structure");
const view = RangeLab.viewModel(data, "fixed");
assert.equal(view.expectancy, "-0.2% / trade");
assert.equal(view.passed, false);
assert.equal(view.range.low, 70000);
assert.equal(view.paper.metrics.trades, 1);
assert.equal(view.paperExpectancy, "+0.5% / trade");
assert.equal(view.paperProfitFactor, "∞");
assert.equal(view.paperStatus, "Open long observation · 3/80 bars");
assert.deepEqual(view.exitComparison, {
  baselineValidation: "-0.8% / trade",
  runnerValidation: "-0.2% / trade",
  baselineHoldout: "-0.4% / trade",
  runnerHoldout: "+0.5% / trade",
  runnerHoldoutTrades: 24,
  runnerHoldoutProfitFactor: "1.30",
  validationEligible: false,
});
assert.deepEqual(view.walkForward, {
  stable: false,
  status: "did not pass the frozen historical stability screen",
  eligibleWindows: 2,
  positiveWindows: 1,
  positiveShare: "50%",
  aggregateTrades: 39,
  aggregateExpectancy: "-1.0132% / trade",
  aggregateProfitFactor: "0.33",
  aggregateDrawdown: "33.19%",
  windows: [
    {
      label: "2023 H1",
      regime: "bull",
      marketReturn: "+84.49% BTC",
      trades: 2,
      expectancy: "-2.6766% / trade",
      profitFactor: "0.00",
      sampleEligible: false,
      positive: false,
    },
    {
      label: "2023 H2",
      regime: "bull",
      marketReturn: "+39.09% BTC",
      trades: 11,
      expectancy: "+0.085% / trade",
      profitFactor: "1.10",
      sampleEligible: true,
      positive: true,
    },
  ],
});
assert.equal(RangeLab.freshness(data, Date.parse("2026-11-06T10:00:00Z")).stale, false);
assert.equal(RangeLab.freshness(data, Date.parse("2026-11-07T10:00:00Z")).stale, true);
assert.equal(RangeLab.researchCutoff(data), "2026-11-06");
assert.equal(RangeLab.forwardStart(data), "2026-11-06");
assert.deepEqual(RangeLab.reconciliationView(data), {
  overlap: "719 aligned 4H candles",
  missing: "0 missing timestamps",
  signedCloseBasis: "+0.08% mean futures basis",
  p95CloseBasis: "0.21% p95 absolute close difference",
  p95OhlcBasis: "p95 abs O/H/L/C 0.18% / 0.31% / 0.29% / 0.21%",
  directionAgreement: "95.2% candle-direction agreement",
  start: "2026-07-10",
  end: "2026-11-06",
});
data.candidates[0].metrics.holdout.profit_factor_infinite = true;
assert.equal(RangeLab.viewModel(data, "fixed").profitFactor, "∞");
console.log("range-lab tests passed");
