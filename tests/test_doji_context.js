const assert = require("node:assert/strict");
const test = require("node:test");
const { analyze, wilson95 } = require("../scripts/analyze-spy-doji-streaks.js");
const Context = require("../site/doji-context.js");

const bars = [
  { time: 60, open: 10, high: 11, low: 9, close: 10.1 },
  { time: 120, open: 10.1, high: 11, low: 9, close: 10.2 },
  { time: 180, open: 10, high: 11, low: 10, close: 11 },
  { time: 240, open: 11, high: 12, low: 10, close: 10.9 },
  { time: 360, open: 10, high: 11, low: 10, close: 11 },
  { time: 420, open: 11, high: 11, low: 10, close: 10 },
  { time: 480, open: 10, high: 10, low: 10, close: 10 },
  { time: 540, open: 10, high: 11, low: 9, close: 10 },
  { time: 600, open: 10, high: 11, low: 10, close: 11 },
];

test("research excludes gaps, forming outcomes, and flat baseline candles; ties are not favorable", () => {
  const result = analyze(1, "regular", bars, 540);
  const d1 = result.rows.find((row) => row.direction === "green" && row.streak === 1);
  const d2 = result.rows.find((row) => row.direction === "green" && row.streak === 2);
  assert.deepEqual([d1.events, d1.nextCloseFavorable, d1.nextSameColorDoji], [1, 1, 1]);
  assert.deepEqual([d2.events, d2.nextCloseFavorable, d2.nextSameColorDoji], [1, 1, 0]);
  assert.equal(result.rows.filter((row) => row.direction === "red").reduce((sum, row) => sum + row.events, 0), 0);
  assert.deepEqual(result.baseline.map(({ events, nextCloseFavorable }) => [events, nextCloseFavorable]), [[2, 0], [1, 0]]);
  assert.equal(analyze(1, "regular", bars, 600).rows.find((row) => row.direction === "green" && row.streak === 1).events, 2);
});

test("research rejects invalid cutoff, OHLC, and duplicate timestamps", () => {
  assert.throws(() => analyze(1, "regular", bars, NaN));
  assert.throws(() => analyze(1, "regular", [{ ...bars[0], close: 20 }], 600));
  assert.throws(() => analyze(1, "regular", [bars[0], bars[0]], 600));
  assert.equal(wilson95(0, 0), null);
  assert.deepEqual(wilson95(7, 9), [0.4526, 0.9368]);
});

test("Heikin Ashi patterns use real next-close outcomes and real next-candle color", () => {
  const source = [
    { time: 60, open: 10, high: 25, low: 5, close: 20 },
    { time: 120, open: 20, high: 21, low: 14, close: 15 },
    { time: 180, open: 15, high: 16, low: 8, close: 9 },
  ];
  const result = analyze(1, "heikin-ashi", source, 180);
  const green = result.rows.find((row) => row.direction === "green" && row.streak === 1);
  assert.deepEqual([green.events, green.nextCloseFavorable, green.nextBarSameColor], [1, 0, 0]);
  assert.deepEqual(result.baseline.map(({ events, nextCloseFavorable }) => [events, nextCloseFavorable]), [[1, 0], [0, 0]]);
});

function fixture() {
  const { rows, baseline } = analyze(1, "regular", bars, 540);
  return { schemaVersion: 2, sourceGeneratedAtUtc: "2026-11-16T16:32:31Z", rows, baselines: baseline,
    coverage: [{ timeframeMinutes: 1, first: 60, last: 540 }] };
}

test("panel matches exact style, color, timeframe and streak, with honest empty and small samples", () => {
  const data = fixture();
  const d1 = Context.summarize(data, "1", "regular", { ...bars[0], streak: 1 });
  assert.equal(d1.sampleLabel, "Too few examples");
  assert.equal(d1.difference, 100);
  assert.equal(Context.frequency(1, 3), "1 / 3 · 33.3%");
  const d3 = Context.summarize(data, 1, "regular", { ...bars[0], streak: 3 });
  assert.equal(d3.sampleLabel, "No eligible examples");
  assert.equal(d3.rate, null);
  assert.equal(d3.difference, null);
  assert.equal(Context.frequency(0, 0), "No eligible examples");
  assert.equal(Context.summarize(data, 1, "regular", { ...bars[0], streak: 8 }).streak, "6+");
  assert.throws(() => Context.summarize(data, 5, "regular", { ...bars[0], streak: 1 }));
  assert.throws(() => Context.summarize(data, 1, "heikin-ashi", { ...bars[0], streak: 1 }));
  data.rows[0].nextCloseFavorable = 999;
  assert.throws(() => Context.summarize(data, 1, "regular", { ...bars[0], streak: 1 }));
});
