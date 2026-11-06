const assert = require("node:assert/strict");
const RangeLab = require("../site/range-lab.js");

const data = {
  generated_at: "2026-11-06T04:00:00Z",
  current_range_data_through: "2026-11-06T04:00:00Z",
  research_metrics_through: "2026-11-06T04:00:00Z",
  forward_tracking: { frozen_at: "2026-11-06T04:00:00Z" },
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
assert.equal(RangeLab.freshness(data, Date.parse("2026-11-06T10:00:00Z")).stale, false);
assert.equal(RangeLab.freshness(data, Date.parse("2026-11-07T10:00:00Z")).stale, true);
assert.equal(RangeLab.researchCutoff(data), "2026-11-06");
assert.equal(RangeLab.forwardStart(data), "2026-11-06");
data.candidates[0].metrics.holdout.profit_factor_infinite = true;
assert.equal(RangeLab.viewModel(data, "fixed").profitFactor, "∞");
console.log("range-lab tests passed");
