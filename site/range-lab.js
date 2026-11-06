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
      profitFactor: holdout.profit_factor_infinite
        ? "∞"
        : Number.isFinite(holdout.profit_factor) ? holdout.profit_factor.toFixed(2) : "—",
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

  return { candidateByKey, defaultKey, freshness, metric, researchCutoff, viewModel };
});
