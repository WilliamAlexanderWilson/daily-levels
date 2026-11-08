(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PaperTrader = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function normalizeLeverage(value) {
    const leverage = Number(value);
    return Number.isInteger(leverage) && leverage >= 1 && leverage <= 100 ? leverage : null;
  }

  function pnl(trade, currentPrice) {
    const leverage = normalizeLeverage(trade && trade.leverage);
    if (!trade || !Number.isFinite(trade.price) || trade.price <= 0 || !Number.isFinite(trade.size) || trade.size <= 0 || !leverage) return null;
    const referencePrice = trade.exitPrice != null ? Number(trade.exitPrice) : Number(currentPrice);
    if (!Number.isFinite(referencePrice) || referencePrice <= 0) return null;
    const change = trade.direction === "long"
      ? (referencePrice - trade.price) / trade.price
      : (trade.price - referencePrice) / trade.price;
    return {
      usd: trade.size * leverage * change,
      pct: leverage * change * 100,
      isRealized: trade.exitPrice != null,
    };
  }

  function estimatedLiquidationPrice(trade) {
    const leverage = normalizeLeverage(trade && trade.leverage);
    if (!trade || !Number.isFinite(trade.price) || trade.price <= 0 || !leverage) return null;
    const price = trade.direction === "long"
      ? trade.price * (1 - 1 / leverage)
      : trade.price * (1 + 1 / leverage);
    return price > 0 ? price : null;
  }

  return { normalizeLeverage, pnl, estimatedLiquidationPrice };
});
