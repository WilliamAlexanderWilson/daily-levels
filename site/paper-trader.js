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
    const liquidation = estimatedLiquidationPrice(trade);
    const liquidated = trade.liquidated === true || (
      liquidation != null && (
        (trade.direction === "long" && referencePrice <= liquidation) ||
        (trade.direction === "short" && referencePrice >= liquidation)
      )
    );
    if (liquidated) {
      return { usd: -trade.size, pct: -100, isRealized: trade.exitPrice != null, isLiquidated: true };
    }
    const change = trade.direction === "long"
      ? (referencePrice - trade.price) / trade.price
      : (trade.price - referencePrice) / trade.price;
    return {
      usd: trade.size * leverage * change,
      pct: leverage * change * 100,
      isRealized: trade.exitPrice != null,
      isLiquidated: false,
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

  function isLiquidationCrossed(trade, currentPrice) {
    const liquidation = estimatedLiquidationPrice(trade);
    const mark = Number(currentPrice);
    if (liquidation == null || !Number.isFinite(mark) || mark <= 0) return false;
    return trade.direction === "long" ? mark <= liquidation : mark >= liquidation;
  }

  return { normalizeLeverage, pnl, estimatedLiquidationPrice, isLiquidationCrossed };
});
