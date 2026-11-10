(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CandleStyle = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  function heikinAshiBar(candle, previous = null) {
    const close = (candle.open + candle.high + candle.low + candle.close) / 4;
    const open = previous
      ? (previous.open + previous.close) / 2
      : (candle.open + candle.close) / 2;
    return {
      ...candle,
      open,
      high: Math.max(candle.high, open, close),
      low: Math.min(candle.low, open, close),
      close,
    };
  }

  function toHeikinAshi(candles) {
    const result = [];
    for (const candle of candles || []) {
      result.push(heikinAshiBar(candle, result[result.length - 1] || null));
    }
    return result;
  }

  function forStyle(candles, style) {
    return style === "heikin-ashi" ? toHeikinAshi(candles) : [...(candles || [])];
  }

  return { heikinAshiBar, toHeikinAshi, forStyle };
});
