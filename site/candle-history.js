(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CandleHistory = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const RANGE_CONFIG = Object.freeze({
    "1m": { sourceSeconds: 60, targetSeconds: 60 },
    "5m": { sourceSeconds: 300, targetSeconds: 300 },
    "15m": { sourceSeconds: 900, targetSeconds: 900 },
    "30m": { sourceSeconds: 900, targetSeconds: 1800 },
    "1h": { sourceSeconds: 3600, targetSeconds: 3600 },
    "4h": { sourceSeconds: 3600, targetSeconds: 14400 },
  });

  function requestWindow(range, beforeUnix, maxSourceCandles = 300) {
    const config = RANGE_CONFIG[range];
    if (!config || !Number.isFinite(beforeUnix)) return null;
    const end = Math.floor(beforeUnix / config.targetSeconds) * config.targetSeconds;
    return {
      granularity: config.sourceSeconds,
      startUnix: end - config.sourceSeconds * maxSourceCandles,
      endUnix: end,
    };
  }

  function fromCoinbaseRows(rows, range, beforeUnix = Infinity) {
    const config = RANGE_CONFIG[range];
    if (!config || !Array.isArray(rows)) return [];
    const normalized = rows
      .map((row) => ({
        time: Number(row[0]),
        low: Number(row[1]),
        high: Number(row[2]),
        open: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5] || 0),
      }))
      .filter((bar) => Object.values(bar).every(Number.isFinite) && bar.time < beforeUnix)
      .sort((a, b) => a.time - b.time);

    if (config.sourceSeconds === config.targetSeconds) return normalized;

    const groups = new Map();
    for (const bar of normalized) {
      const time = Math.floor(bar.time / config.targetSeconds) * config.targetSeconds;
      const group = groups.get(time);
      if (!group) {
        groups.set(time, { ...bar, time });
        continue;
      }
      group.high = Math.max(group.high, bar.high);
      group.low = Math.min(group.low, bar.low);
      group.close = bar.close;
      group.volume += bar.volume;
    }
    return [...groups.values()].sort((a, b) => a.time - b.time);
  }

  function mergeOlder(older, current) {
    const byTime = new Map();
    for (const bar of older || []) byTime.set(bar.time, bar);
    // Kraken remains authoritative anywhere the two spot feeds overlap.
    for (const bar of current || []) byTime.set(bar.time, bar);
    return [...byTime.values()].sort((a, b) => a.time - b.time);
  }

  return { RANGE_CONFIG, requestWindow, fromCoinbaseRows, mergeOlder };
});
