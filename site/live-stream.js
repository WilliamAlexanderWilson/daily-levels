(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.KrakenLive = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const URL = "wss://ws.kraken.com/v2";

  function subscriptionRequest(symbol, interval, reqId = 1) {
    return {
      method: "subscribe",
      params: {
        channel: "ohlc",
        symbol: [symbol],
        interval,
        snapshot: true,
      },
      req_id: reqId,
    };
  }

  function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function normalizeCandle(row) {
    if (!row || typeof row !== "object") return null;
    const time = Math.floor(Date.parse(row.interval_begin || row.timestamp) / 1000);
    const open = finiteNumber(row.open);
    const high = finiteNumber(row.high);
    const low = finiteNumber(row.low);
    const close = finiteNumber(row.close);
    const volume = finiteNumber(row.volume);
    if (![time, open, high, low, close, volume].every(Number.isFinite)) return null;
    return { time, open, high, low, close, volume };
  }

  function isStreamFresh(subscribed, lastMessageAt, now, staleAfterMs) {
    return Boolean(
      subscribed
      && Number.isFinite(lastMessageAt)
      && Number.isFinite(now)
      && Number.isFinite(staleAfterMs)
      && now - lastMessageAt <= staleAfterMs
    );
  }

  function parseMessage(message, expectedSymbol, expectedInterval) {
    let payload = message;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch (_) {
        return null;
      }
    }
    if (!payload || typeof payload !== "object") return null;

    if (payload.method === "subscribe" && payload.success === false) {
      return {
        kind: "subscription",
        success: false,
        error: payload.error || "Kraken rejected the OHLC subscription",
        symbol: null,
        interval: null,
      };
    }

    if (payload.method === "subscribe" && payload.result && payload.result.channel === "ohlc") {
      return {
        kind: "subscription",
        success: payload.success !== false,
        error: payload.error || null,
        symbol: payload.result.symbol,
        interval: payload.result.interval,
      };
    }

    if (payload.channel !== "ohlc" || !Array.isArray(payload.data)) return null;
    const candles = payload.data
      .filter((row) => row.symbol === expectedSymbol && Number(row.interval) === Number(expectedInterval))
      .map(normalizeCandle)
      .filter(Boolean)
      .sort((a, b) => a.time - b.time);
    return candles.length ? { kind: "candles", type: payload.type, candles } : null;
  }

  return { URL, subscriptionRequest, normalizeCandle, isStreamFresh, parseMessage };
});
