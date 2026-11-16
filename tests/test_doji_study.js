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

test("Regular and Heikin Ashi modes mark only dojis visible in that mode", () => {
  const regularOnly = [{ time: 0, open: 10, high: 20, low: 10, close: 10 }];
  const heikinAshiOnly = [{ time: 0, open: 10, high: 25, low: 5, close: 20 }];
  const options = { intervalMinutes: 1, completedThroughUnix: 60 };

  assert.equal(DojiStudy.findCompleted(regularOnly, { ...options, style: "regular" }).length, 1);
  assert.equal(DojiStudy.findCompleted(regularOnly, { ...options, style: "heikin-ashi" }).length, 0);
  assert.equal(DojiStudy.findCompleted(heikinAshiOnly, { ...options, style: "regular" }).length, 0);
  assert.equal(DojiStudy.findCompleted(heikinAshiOnly, { ...options, style: "heikin-ashi" }).length, 1);
});

test("same-color dojis count D1 onward and reset on color, non-doji, or a missing bar", () => {
  const green = (time) => ({ time, open: 10, high: 11, low: 9, close: 10.01 });
  const red = (time) => ({ time, open: 10, high: 11, low: 9, close: 9.99 });
  const fullBody = (time) => ({ time, open: 10, high: 11, low: 10, close: 11 });
  const bars = [green(60), green(120), green(180), green(240), red(300), red(360),
    fullBody(420), green(480), green(600)];
  const found = DojiStudy.findCompleted(bars, {
    intervalMinutes: 1, completedThroughUnix: 600, timeIsClose: true, style: "regular",
  });
  assert.deepEqual(found.map(({ time, streak }) => [time, streak]),
    [[60, 1], [120, 2], [180, 3], [240, 4], [300, 1], [360, 2], [480, 1], [600, 1]]);
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

test("starts at one minute and excludes flat no-range bars", () => {
  assert.equal(DojiStudy.MIN_TIMEFRAME_MINUTES, 1);
  for (const intervalMinutes of [0, NaN]) {
    assert.equal(DojiStudy.findCompleted(candles, {
      intervalMinutes,
      completedThroughUnix: 9999,
    }).length, 0);
  }
  assert.equal(DojiStudy.isDoji({ open: 10, high: 10, low: 10, close: 10 }), false);
});

test("uses the same completed-candle rule from 1m through Daily", () => {
  for (const intervalMinutes of [1, 5, 10, 15, 30, 60, 240, 1440]) {
    const result = DojiStudy.findCompleted([candles[0]], {
      intervalMinutes,
      completedThroughUnix: intervalMinutes * 60,
    });
    assert.equal(result.length, 1, `${intervalMinutes}m should be eligible`);
  }
});

test("supports equity bars whose timestamp is already the close boundary", () => {
  for (const intervalMinutes of [1, 5, 10, 15]) {
    const forming = DojiStudy.findCompleted([candles[0]], {
      intervalMinutes,
      completedThroughUnix: -1,
      timeIsClose: true,
    });
    const completed = DojiStudy.findCompleted([candles[0]], {
      intervalMinutes,
      completedThroughUnix: 0,
      timeIsClose: true,
    });
    assert.equal(forming.length, 0, `${intervalMinutes}m bar must be complete`);
    assert.equal(completed.length, 1, `${intervalMinutes}m close is inclusive`);
  }
});
