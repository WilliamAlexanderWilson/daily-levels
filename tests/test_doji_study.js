const assert = require("node:assert/strict");
const test = require("node:test");

const DojiStudy = require("../site/doji-study.js");

const candles = [
  { time: 0, open: 10, high: 12, low: 8, close: 10 },
  { time: 900, open: 10, high: 20, low: 10, close: 20 },
  { time: 1800, open: 15, high: 15, low: 15, close: 15 },
];

test("marks only completed Heikin Ashi dojis", () => {
  const beforeSecondClose = DojiStudy.findCompleted(candles, {
    intervalMinutes: 15,
    completedThroughUnix: 1799,
  });
  assert.deepEqual(beforeSecondClose.map((bar) => bar.time), [0]);
  assert.equal(beforeSecondClose[0].bodyRatio, 0);
});

test("does not mark a live forming candle until its interval ends", () => {
  const forming = [{ time: 900, open: 10, high: 12, low: 8, close: 10 }];
  assert.equal(DojiStudy.findCompleted(forming, {
    intervalMinutes: 15,
    completedThroughUnix: 1799,
  }).length, 0);
  assert.equal(DojiStudy.findCompleted(forming, {
    intervalMinutes: 15,
    completedThroughUnix: 1800,
  }).length, 1);
});

test("starts at 15 minutes and excludes flat no-range bars", () => {
  assert.equal(DojiStudy.findCompleted(candles, {
    intervalMinutes: 10,
    completedThroughUnix: 9999,
  }).length, 0);
  assert.equal(DojiStudy.isDoji({ open: 10, high: 10, low: 10, close: 10 }), false);
});

test("uses the same completed-candle rule at 15m, 30m, 1H, 4H, and Daily", () => {
  for (const intervalMinutes of [15, 30, 60, 240, 1440]) {
    const result = DojiStudy.findCompleted([candles[0]], {
      intervalMinutes,
      completedThroughUnix: intervalMinutes * 60,
    });
    assert.equal(result.length, 1, `${intervalMinutes}m should be eligible`);
  }
});

test("supports equity bars whose timestamp is already the close boundary", () => {
  const result = DojiStudy.findCompleted([candles[0]], {
    intervalMinutes: 15,
    completedThroughUnix: 0,
    timeIsClose: true,
  });
  assert.equal(result.length, 1);
});
