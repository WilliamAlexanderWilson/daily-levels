const assert = require("node:assert/strict");
const test = require("node:test");

const CandleStyle = require("../site/candle-style.js");

const candles = [
  { time: 1, open: 10, high: 12, low: 9, close: 11, volume: 100 },
  { time: 2, open: 11, high: 13, low: 10, close: 12, volume: 110 },
  { time: 3, open: 12, high: 12, low: 8, close: 9, volume: 120 },
];

test("converts ordinary candles to hand-verifiable Heikin Ashi bars", () => {
  const result = CandleStyle.toHeikinAshi(candles);
  assert.deepEqual(result.map((bar) => bar.close), [10.5, 11.5, 10.25]);
  assert.deepEqual(result.map((bar) => bar.open), [10.5, 10.5, 11]);
  assert.deepEqual(result.map((bar) => bar.high), [12, 13, 12]);
  assert.deepEqual(result.map((bar) => bar.low), [9, 10, 8]);
  assert.deepEqual(result.map((bar) => bar.volume), [100, 110, 120]);
});

test("regular style preserves actual OHLC while returning a new array", () => {
  const result = CandleStyle.forStyle(candles, "regular");
  assert.deepEqual(result, candles);
  assert.notEqual(result, candles);
});

test("a live Heikin Ashi update uses the previous derived bar", () => {
  const firstTwo = CandleStyle.toHeikinAshi(candles.slice(0, 2));
  const third = CandleStyle.heikinAshiBar(candles[2], firstTwo[1]);
  assert.equal(third.open, 11);
  assert.equal(third.close, 10.25);
});
