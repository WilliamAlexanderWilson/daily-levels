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
      robustness: {
        robust: false,
        status: "did not pass the frozen historical robustness screen",
        sample_adequate: true,
        sample_warning: null,
        direction_balanced: false,
        cost_resilient: false,
        directions: {
          long: {
            sample_adequate: true,
            positive: false,
            metrics: { trades: 53, expectancy_pct: -0.0832, profit_factor: 0.952, profit_factor_infinite: false },
          },
          short: {
            sample_adequate: true,
            positive: false,
            metrics: { trades: 39, expectancy_pct: -1.0226, profit_factor: 0.503, profit_factor_infinite: false },
          },
        },
        cost_scenarios: [
          {
            key: "base", label: "Base", fee_per_side_pct: 0.2, slippage_per_side_pct: 0.05,
            metrics: { trades: 92, expectancy_pct: -0.4814, profit_factor: 0.742, profit_factor_infinite: false, max_drawdown_pct: 46.83 },
          },
          {
            key: "severe", label: "Severe", fee_per_side_pct: 0.4, slippage_per_side_pct: 0.15,
            metrics: { trades: 92, expectancy_pct: -1.083, profit_factor: 0.521, profit_factor_infinite: false, max_drawdown_pct: 67.89 },
          },
        ],
        drawdown_duration: {
          max_underwater_trades: 75,
          max_underwater_days: 1011.67,
          recovered: false,
        },
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
assert.deepEqual(view.robustness, {
  robust: false,
  status: "did not pass the frozen historical robustness screen",
  sampleAdequate: true,
  sampleWarning: null,
  directionBalanced: false,
  costResilient: false,
  directions: [
    {
      direction: "long",
      trades: 53,
      expectancy: "-0.0832% / trade",
      profitFactor: "0.95",
      sampleAdequate: true,
      positive: false,
    },
    {
      direction: "short",
      trades: 39,
      expectancy: "-1.0226% / trade",
      profitFactor: "0.50",
      sampleAdequate: true,
      positive: false,
    },
  ],
  costScenarios: [
    {
      key: "base", label: "Base", fee: "0.2% fee", slippage: "0.05% slip", trades: 92,
      expectancy: "-0.4814% / trade", profitFactor: "0.74", drawdown: "46.83%", positive: false,
    },
    {
      key: "severe", label: "Severe", fee: "0.4% fee", slippage: "0.15% slip", trades: 92,
      expectancy: "-1.083% / trade", profitFactor: "0.52", drawdown: "67.89%", positive: false,
    },
  ],
  drawdown: { trades: 75, days: "1011.67", recovered: false },
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
