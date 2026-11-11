const assert = require("node:assert/strict");
const test = require("node:test");

const CandleHistory = require("../site/candle-history.js");

test("plans a Coinbase page ending immediately before the oldest loaded candle", () => {
  const plan = CandleHistory.requestWindow("4h", 1_800_000_000);
  assert.equal(plan.granularity, 3600);
  assert.equal(plan.endUnix % (4 * 3600), 0);
  assert.equal(plan.endUnix - plan.startUnix, 300 * 3600);
});

test("aggregates ordered one-hour Coinbase rows into reproducible four-hour candles", () => {
  const base = 1_799_971_200; // aligned four-hour boundary
  const rows = [
    [base + 3 * 3600, 9, 15, 13, 14, 4],
    [base, 8, 12, 10, 11, 1],
    [base + 2 * 3600, 10, 14, 12, 13, 3],
    [base + 3600, 7, 13, 11, 12, 2],
  ];
  assert.deepEqual(CandleHistory.fromCoinbaseRows(rows, "4h"), [{
    time: base,
    low: 7,
    high: 15,
    open: 10,
    close: 14,
    volume: 10,
  }]);
});

test("filters overlap and lets current Kraken candles win", () => {
  const older = [
    { time: 100, open: 1, high: 2, low: 1, close: 2, volume: 1 },
    { time: 200, open: 2, high: 3, low: 2, close: 3, volume: 1 },
  ];
  const current = [{ time: 200, open: 20, high: 30, low: 20, close: 30, volume: 10 }];
  const merged = CandleHistory.mergeOlder(older, current);
  assert.equal(merged.length, 2);
  assert.equal(merged[1].close, 30);
});
