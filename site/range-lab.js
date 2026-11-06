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
    return {
      key: candidate.spec.key,
      label: candidate.spec.label,
      method: candidate.spec.method,
      range: candidate.latest_range,
      holdout,
      expectancy: metric(holdout.expectancy_pct, "% / trade"),
      totalReturn: metric(holdout.total_return_pct, "%"),
      profitFactor: Number.isFinite(holdout.profit_factor) ? holdout.profit_factor.toFixed(2) : "—",
      passed: Boolean(data.holdout_passed && data.selected_key === candidate.spec.key),
    };
  }

  return { candidateByKey, defaultKey, metric, viewModel };
});

