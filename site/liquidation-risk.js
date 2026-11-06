(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.LiquidationRisk = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function smoothValues(values, windowRadius) {
    const radius = Math.max(0, Math.floor(Number(windowRadius) || 0));
    const out = new Array(values.length);
    for (let i = 0; i < values.length; i++) {
      let sum = 0;
      let count = 0;
      for (let j = Math.max(0, i - radius); j <= Math.min(values.length - 1, i + radius); j++) {
        sum += Number(values[j]) || 0;
        count++;
      }
      out[i] = count ? sum / count : 0;
    }
    return out;
  }

  function buildRiskRows(bins, options = {}) {
    if (!Array.isArray(bins) || !bins.length) return [];
    const radius = options.smoothingRadius ?? 4;
    const threshold = options.threshold ?? 0.8;
    const smoothedLong = smoothValues(bins.map((bin) => bin.long_intensity), radius);
    const smoothedShort = smoothValues(bins.map((bin) => bin.short_intensity), radius);
    const globalPeak = Math.max(0, ...smoothedLong, ...smoothedShort);
    if (!globalPeak) return [];

    return bins.map((bin, index) => {
      const long = smoothedLong[index];
      const short = smoothedShort[index];
      const isLong = long >= short;
      const relative = Math.min(1, Math.max(long, short) / globalPeak);
      return {
        bin,
        side: isLong ? "long" : "short",
        relative,
        significant: relative >= threshold,
      };
    });
  }

  function opacityForRelative(relative, options = {}) {
    const threshold = options.threshold ?? 0.8;
    const maxOpacity = options.maxOpacity ?? 0.32;
    const exponent = options.exponent ?? 2.2;
    if (!Number.isFinite(relative) || relative < threshold || threshold >= 1) return 0;
    const aboveThreshold = (relative - threshold) / (1 - threshold);
    return Math.pow(Math.min(1, Math.max(0, aboveThreshold)), exponent) * maxOpacity;
  }

  return { smoothValues, buildRiskRows, opacityForRelative };
});
