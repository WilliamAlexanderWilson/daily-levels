const test = require("node:test");
const assert = require("node:assert/strict");
const Live = require("../site/spy-live.js");
const unix = (value) => Date.parse(value) / 1000;
const bar = (time, open = 10, close = 10.01) => ({ time: unix(time), open, high: 11, low: 9, close, volume: 10 });

test("SPY minute bars convert open timestamps to close timestamps and reject invalid data", () => {
  const raw = { S: "SPY", t: "2026-11-16T14:30:00Z", o: 10, h: 11, l: 9, c: 10.01, v: 10 };
  assert.deepEqual(Live.normalizeBar(raw), bar("2026-11-16T14:31:00Z"));
  for (const change of [{ S: "QQQ" }, { c: 20 }, { v: -1 }, { t: "invalid" }, { o: null }]) {
    assert.equal(Live.normalizeBar({ ...raw, ...change }), null);
  }
});

test("SPY buckets anchor to New York cash open across DST and end at the session close", () => {
  assert.equal(Live.bucketForMinute(unix("2026-11-16T14:31:00Z"), 60).time, unix("2026-11-16T15:30:00Z"));
  assert.equal(Live.bucketForMinute(unix("2026-07-06T13:31:00Z"), 60).time, unix("2026-07-06T14:30:00Z"));
  assert.equal(Live.bucketForMinute(unix("2026-11-16T20:59:00Z"), 240).time, unix("2026-11-16T21:00:00Z"));
  assert.equal(Live.bucketForMinute(unix("2026-11-27T17:59:00Z"), 240).time, unix("2026-11-27T18:00:00Z"));
  assert.equal(Live.bucketForMinute(unix("2026-11-26T15:00:00Z"), 1), null);
  assert.equal(Live.bucketForMinute(unix("2026-11-15T15:00:00Z"), 1), null);
  assert.equal(Live.bucketForMinute(unix("2026-11-16T14:30:00Z"), 1), null);
});

test("SPY aggregation excludes unfinished and partial-start buckets without fabricating missing minutes", () => {
  const bars = [bar("2026-11-16T14:31:00Z"), bar("2026-11-16T14:33:00Z", 10.01, 10.1)];
  assert.equal(Live.aggregate(5, bars, unix("2026-11-16T14:34:00Z")).length, 0);
  const [complete] = Live.aggregate(5, bars, unix("2026-11-16T14:35:00Z"));
  assert.deepEqual([complete.time, complete.open, complete.close, complete.volume], [unix("2026-11-16T14:35:00Z"), 10, 10.1, 20]);
  assert.equal(Live.aggregate(5, bars, unix("2026-11-16T14:35:00Z"), unix("2026-11-16T14:31:00Z")).length, 0);
  assert.equal(Live.aggregate(1, bars, unix("2026-11-16T14:35:00Z")).length, 2);
});

test("late corrected bars replace existing candles and preserve older chart history", () => {
  const original = bar("2026-11-16T14:31:00Z");
  const older = bar("2026-11-13T20:59:00Z");
  const corrected = { ...original, close: 10.8 };
  const merged = Live.mergeBars([older, original], [corrected]);
  assert.equal(merged.length, 2);
  assert.equal(merged[1].close, 10.8);
  assert.deepEqual(merged[0], older);
  assert.equal(Live.mergeTimeframes({ 1: [older] }, merged, original.time, unix("2026-11-16T14:30:00Z"))[1].length, 2);
});

test("live SPY follows the newest candle without moving a historical viewport or changing zoom", () => {
  assert.deepEqual(Live.liveViewport({ from: 70, to: 105 }, 100, 101), { from: 71, to: 106 });
  assert.deepEqual(Live.liveViewport({ from: 10, to: 45 }, 100, 101), { from: 10, to: 45 });
  assert.deepEqual(Live.liveViewport({ from: 100, to: 135 }, 100, 101), { from: 100, to: 135 });
  assert.equal(Live.liveViewport(null, 100, 101), null);
});
