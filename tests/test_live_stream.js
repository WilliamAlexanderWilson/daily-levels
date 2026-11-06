const test = require("node:test");
const assert = require("node:assert/strict");
const KrakenLive = require("../site/live-stream.js");

test("builds a public OHLC subscription for the selected market and timeframe", () => {
  assert.deepEqual(KrakenLive.subscriptionRequest("BTC/USD", 240, 7), {
    method: "subscribe",
    params: {
      channel: "ohlc",
      symbol: ["BTC/USD"],
      interval: 240,
      snapshot: true,
    },
    req_id: 7,
  });
});

test("parses every-trade OHLC updates into chart candle data", () => {
  const result = KrakenLive.parseMessage({
    channel: "ohlc",
    type: "update",
    data: [{
      symbol: "BTC/USD",
      interval: 240,
      interval_begin: "2026-11-06T04:00:00.000000Z",
      open: 75200,
      high: 75325.5,
      low: 75180,
      close: 75310.2,
      volume: 12.4,
    }],
  }, "BTC/USD", 240);

  assert.equal(result.kind, "candles");
  assert.equal(result.type, "update");
  assert.deepEqual(result.candles[0], {
    time: 1793937600,
    open: 75200,
    high: 75325.5,
    low: 75180,
    close: 75310.2,
    volume: 12.4,
  });
});

test("ignores unrelated markets, intervals, and malformed data", () => {
  assert.equal(KrakenLive.parseMessage({
    channel: "ohlc",
    type: "update",
    data: [{ symbol: "ETH/USD", interval: 240, interval_begin: "2026-11-06T04:00:00Z", open: 1, high: 2, low: 1, close: 2, volume: 3 }],
  }, "BTC/USD", 240), null);

  assert.equal(KrakenLive.normalizeCandle({
    interval_begin: "not-a-date",
    open: 1,
    high: 2,
    low: 1,
    close: 2,
    volume: 3,
  }), null);
});

test("surfaces a rejected subscription so the client can reconnect", () => {
  assert.deepEqual(KrakenLive.parseMessage({
    method: "subscribe",
    success: false,
    error: "Unsupported interval",
    req_id: 7,
  }, "BTC/USD", 240), {
    kind: "subscription",
    success: false,
    error: "Unsupported interval",
    symbol: null,
    interval: null,
  });
});

test("treats an acknowledged but silent stream as stale", () => {
  assert.equal(KrakenLive.isStreamFresh(true, 1000, 15999, 15000), true);
  assert.equal(KrakenLive.isStreamFresh(true, 1000, 16001, 15000), false);
  assert.equal(KrakenLive.isStreamFresh(false, 1000, 1001, 15000), false);
  assert.equal(KrakenLive.isStreamFresh(true, null, 1001, 15000), false);
});
