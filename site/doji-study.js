(function (root, factory) {
  const candleStyle = typeof module === "object" && module.exports
    ? require("./candle-style.js")
    : root.CandleStyle;
  const api = factory(candleStyle);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.DojiStudy = api;
})(typeof window !== "undefined" ? window : globalThis, function (CandleStyle) {
  "use strict";

  const MIN_TIMEFRAME_MINUTES = 1;
  const MAX_BODY_RATIO = 0.1;

  function measure(bar) {
    const range = bar.high - bar.low;
    const body = Math.abs(bar.close - bar.open);
    return {
      range,
      body,
      bodyRatio: range > 0 ? body / range : Infinity,
    };
  }

  function isDoji(bar, maxBodyRatio = MAX_BODY_RATIO) {
    const reading = measure(bar);
    return reading.range > 0 && reading.bodyRatio <= maxBodyRatio;
  }

  function findCompleted(candles, options = {}) {
    const intervalMinutes = Number(options.intervalMinutes);
    if (!Number.isFinite(intervalMinutes) || intervalMinutes < MIN_TIMEFRAME_MINUTES) return [];

    const completedThroughUnix = Number.isFinite(options.completedThroughUnix)
      ? options.completedThroughUnix
      : Date.now() / 1000;
    const completionOffset = options.timeIsClose ? 0 : intervalMinutes * 60;
    const heikinAshi = CandleStyle.toHeikinAshi(candles || []);
    const matches = [];

    for (let index = 0; index < heikinAshi.length; index += 1) {
      const source = candles[index];
      const bar = heikinAshi[index];
      if (!source || !Number.isFinite(source.time)) continue;
      if (source.time + completionOffset > completedThroughUnix) continue;
      const reading = measure(bar);
      if (reading.range <= 0 || reading.bodyRatio > MAX_BODY_RATIO) continue;
      matches.push({
        time: source.time,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        bodyRatio: reading.bodyRatio,
      });
    }
    return matches;
  }

  return {
    MIN_TIMEFRAME_MINUTES,
    MAX_BODY_RATIO,
    measure,
    isDoji,
    findCompleted,
  };
});
