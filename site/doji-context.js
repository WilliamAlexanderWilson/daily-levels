(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.DojiContext = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const SMALL_SAMPLE = 30; // A display caution, never an evidence-of-edge threshold.

  function summarize(report, minutes, style, selected) {
    if (report?.schemaVersion !== 2 || !Number.isFinite(Date.parse(report.sourceGeneratedAtUtc))
        || !Array.isArray(report.rows) || !Array.isArray(report.baselines)
        || !Array.isArray(report.coverage)) throw new Error("Invalid doji context data");
    const direction = selected.close >= selected.open ? "green" : "red";
    const streak = selected.streak >= 6 ? "6+" : selected.streak;
    const sameView = (row) => row.timeframeMinutes === Number(minutes)
      && row.style === style && row.direction === direction;
    const row = report.rows.find((item) => sameView(item) && item.streak === streak);
    const baseline = report.baselines.find(sameView);
    const coverage = report.coverage.find((item) => item.timeframeMinutes === Number(minutes));
    for (const count of [row, baseline]) {
      if (!count || !Number.isSafeInteger(count.events) || count.events < 0
          || !Number.isSafeInteger(count.nextCloseFavorable) || count.nextCloseFavorable < 0
          || count.nextCloseFavorable > count.events) throw new Error("Missing or invalid outcome counts");
    }
    for (const field of ["nextBarSameColor", "nextSameColorDoji"]) {
      if (!Number.isSafeInteger(row[field]) || row[field] < 0 || row[field] > row.events) {
        throw new Error("Invalid next-bar counts");
      }
    }
    const interval = row.nextCloseFavorableWilson95;
    if (row.events && (!Array.isArray(interval) || interval.length !== 2
        || !interval.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)
        || interval[0] > interval[1])) throw new Error("Invalid interval");
    if (!coverage || !Number.isFinite(coverage.first) || !Number.isFinite(coverage.last)
        || coverage.last < coverage.first) throw new Error("Missing archive coverage");
    const rate = row.events ? row.nextCloseFavorable / row.events : null;
    const baselineRate = baseline.events ? baseline.nextCloseFavorable / baseline.events : null;
    return {
      row, baseline, coverage, direction, streak, rate, baselineRate,
      difference: rate === null || baselineRate === null ? null : (rate - baselineRate) * 100,
      sampleLabel: row.events === 0 ? "No eligible examples"
        : row.events < SMALL_SAMPLE ? "Too few examples" : "Historical context only",
    };
  }

  function frequency(successes, total) {
    return total ? `${successes.toLocaleString()} / ${total.toLocaleString()} · ${(100 * successes / total).toFixed(1)}%`
      : "No eligible examples";
  }

  return { SMALL_SAMPLE, summarize, frequency };
});
