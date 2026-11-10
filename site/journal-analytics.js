(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.JournalAnalytics = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const ASSETS = ["btc", "eth", "spy", "qqq", "nvda"];

  function finite(value) {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function realizedR(trade) {
    const risk = finite(trade && trade.riskDollars);
    const entry = finite(trade && trade.price);
    const exit = finite(trade && trade.exitPrice);
    const size = finite(trade && trade.size);
    const leverage = finite(trade && trade.leverage);
    if (!(risk > 0) || entry === null || exit === null || !(size > 0) || !(leverage > 0)) return null;
    const direction = trade.direction === "short" ? -1 : 1;
    return (size * leverage * ((exit - entry) / entry) * direction) / risk;
  }

  function summary(records) {
    const rows = Array.isArray(records) ? records : [];
    const closed = rows.filter((row) => finite(row.trade && row.trade.exitPrice) !== null);
    const results = closed.map((row) => ({ ...row, r: realizedR(row.trade) })).filter((row) => row.r !== null);
    const wins = results.filter((row) => row.r > 0).length;
    const losses = results.filter((row) => row.r < 0).length;
    const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    const group = (key) => Object.values(rows.reduce((acc, row) => {
      const label = key(row) || "Unrecorded";
      acc[label] ||= { label, total: 0, closed: 0, realized: [] };
      acc[label].total += 1;
      const r = realizedR(row.trade);
      if (finite(row.trade && row.trade.exitPrice) !== null) acc[label].closed += 1;
      if (r !== null) acc[label].realized.push(r);
      return acc;
    }, {})).map((item) => ({
      label: item.label,
      total: item.total,
      closed: item.closed,
      avgR: average(item.realized),
    }));
    return {
      total: rows.length,
      open: rows.length - closed.length,
      closed: closed.length,
      wins,
      losses,
      breakeven: results.length - wins - losses,
      winRate: results.length ? wins / results.length : null,
      avgPlannedR: average(rows.map((row) => finite(row.trade && row.trade.rewardRisk)).filter((value) => value !== null)),
      avgRealizedR: average(results.map((row) => row.r)),
      byAsset: group((row) => String(row.asset || "").toUpperCase()),
      byLocation: group((row) => row.trade && row.trade.rangeLocation),
    };
  }

  function csv(records) {
    const fields = ["asset", "status", "opened_at", "closed_at", "side", "entry", "exit", "stop", "target", "planned_r", "realized_r", "range_location", "plan"];
    const quote = (value) => `"${String(value == null ? "" : value).replaceAll('"', '""')}"`;
    const lines = [fields.join(",")];
    for (const row of records || []) {
      const t = row.trade || {};
      lines.push([
        String(row.asset || "").toUpperCase(), t.exitPrice == null ? "open" : "closed",
        t.time ? new Date(t.time * 1000).toISOString() : "", t.exitTime ? new Date(t.exitTime * 1000).toISOString() : "",
        t.direction, t.price, t.exitPrice, t.stopPrice, t.targetPrice, t.rewardRisk,
        realizedR(t), t.rangeLocation || "Unrecorded", t.description || "",
      ].map(quote).join(","));
    }
    return lines.join("\n");
  }

  return { ASSETS, realizedR, summary, csv };
});
