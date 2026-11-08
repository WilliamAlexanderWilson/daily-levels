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

  function riskPlan({ direction, entry, stop, target, accountBalance, riskPct, leverage }) {
    const normalizedLeverage = normalizeLeverage(leverage);
    const values = [entry, stop, target, accountBalance, riskPct].map(Number);
    if (!normalizedLeverage || values.some((value) => !Number.isFinite(value) || value <= 0)) {
      return { valid: false, error: "Complete account, risk, leverage, stop, and target." };
    }
    [entry, stop, target, accountBalance, riskPct] = values;
    if (riskPct < 0.1 || riskPct > 5) return { valid: false, error: "Risk per trade must be between 0.1% and 5%." };
    const isLong = direction === "long";
    const isShort = direction === "short";
    if (!isLong && !isShort) return { valid: false, error: "Choose long or short." };
    if ((isLong && stop >= entry) || (isShort && stop <= entry)) {
      return { valid: false, error: `${isLong ? "Long" : "Short"} stop must be ${isLong ? "below" : "above"} entry.` };
    }
    if ((isLong && target <= entry) || (isShort && target >= entry)) {
      return { valid: false, error: `${isLong ? "Long" : "Short"} target must be ${isLong ? "above" : "below"} entry.` };
    }
    const stopFraction = Math.abs(entry - stop) / entry;
    const targetFraction = Math.abs(target - entry) / entry;
    const riskDollars = accountBalance * riskPct / 100;
    const notional = riskDollars / stopFraction;
    const margin = notional / normalizedLeverage;
    const liquidation = estimatedLiquidationPrice({ direction, price: entry, leverage: normalizedLeverage });
    const stopBeforeLiquidation = liquidation == null || (isLong ? stop > liquidation : stop < liquidation);
    if (!stopBeforeLiquidation) {
      return { valid: false, error: "Estimated liquidation comes before the stop. Reduce leverage or move the stop." };
    }
    if (margin > accountBalance) {
      return { valid: false, error: "Calculated margin exceeds the account. Reduce risk or use a wider stop." };
    }
    return {
      valid: true,
      direction,
      entry,
      stop,
      target,
      accountBalance,
      riskPct,
      leverage: normalizedLeverage,
      riskDollars,
      stopFraction,
      targetFraction,
      rewardRisk: targetFraction / stopFraction,
      notional,
      margin,
      liquidation,
    };
  }

  function rMultiple(trade, currentPrice) {
    const result = pnl(trade, currentPrice);
    if (!result || !Number.isFinite(trade && trade.riskDollars) || trade.riskDollars <= 0) return null;
    return result.usd / trade.riskDollars;
  }

  function triggeredExit(trade, currentPrice) {
    if (!trade || trade.exitPrice != null || !Number.isFinite(Number(currentPrice))) return null;
    const mark = Number(currentPrice);
    if (isLiquidationCrossed(trade, mark)) {
      return { reason: "liquidation", price: estimatedLiquidationPrice(trade) };
    }
    if (Number.isFinite(trade.stopPrice)) {
      const hit = trade.direction === "long" ? mark <= trade.stopPrice : mark >= trade.stopPrice;
      if (hit) return { reason: "stop", price: trade.stopPrice };
    }
    if (Number.isFinite(trade.targetPrice)) {
      const hit = trade.direction === "long" ? mark >= trade.targetPrice : mark <= trade.targetPrice;
      if (hit) return { reason: "target", price: trade.targetPrice };
    }
    return null;
  }

  function settleTrades(trades, currentPrice, exitTime = Math.floor(Date.now() / 1000)) {
    if (!Array.isArray(trades) || !Number.isFinite(Number(currentPrice))) {
      return { trades: Array.isArray(trades) ? trades : [], changed: false };
    }
    let changed = false;
    const settled = trades.map((trade) => {
      const exit = triggeredExit(trade, currentPrice);
      if (!exit) return trade;
      changed = true;
      return {
        ...trade,
        exitPrice: exit.price,
        exitTime,
        exitReason: exit.reason,
        liquidated: exit.reason === "liquidation",
      };
    });
    return { trades: settled, changed };
  }

  return { normalizeLeverage, pnl, estimatedLiquidationPrice, isLiquidationCrossed, riskPlan, rMultiple, triggeredExit, settleTrades };
});
