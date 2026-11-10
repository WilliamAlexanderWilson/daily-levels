const test = require("node:test");
const assert = require("node:assert/strict");

const ChartTime = require("../site/chart-time.js");

test("formats winter chart times in Dallas 12-hour time", () => {
  const time = Date.parse("2026-11-08T16:00:00Z") / 1000;
  assert.equal(ChartTime.formatDallasAxisTick(time, 3), "10 AM");
  assert.match(ChartTime.formatDallasCrosshair(time), /Nov 8, 2026, 10:00 AM CST/);
});

test("automatically follows Dallas daylight saving time", () => {
  const time = Date.parse("2026-07-08T16:00:00Z") / 1000;
  assert.equal(ChartTime.formatDallasAxisTick(time, 3), "11 AM");
  assert.match(ChartTime.formatDallasCrosshair(time), /Jul 8, 2026, 11:00 AM CDT/);
});

test("keeps half-hour ticks readable without military time", () => {
  const time = Date.parse("2026-11-08T16:30:00Z") / 1000;
  assert.equal(ChartTime.formatDallasAxisTick(time, 3), "10:30 AM");
});

test("formats calendar-scale ticks in Dallas", () => {
  const time = Date.parse("2026-11-08T16:00:00Z") / 1000;
  assert.equal(ChartTime.formatDallasAxisTick(time, 0), "2026");
  assert.equal(ChartTime.formatDallasAxisTick(time, 1), "Nov");
  assert.equal(ChartTime.formatDallasAxisTick(time, 2), "Nov 8");
});

test("keeps date-only Daily candles date-only", () => {
  assert.equal(ChartTime.formatDallasCrosshair("2024-10-01"), "Oct 1, 2024");
  assert.equal(ChartTime.formatDallasCrosshair({ year: 2024, month: 10, day: 1 }), "Oct 1, 2024");
  assert.equal(ChartTime.formatDallasAxisTick("2024-10-01", 3), "Oct 1");
});

test("returns safe fallbacks for invalid chart times", () => {
  for (const time of [
    "not-a-date",
    "2026-02-30",
    { year: 2026, month: 13, day: 40 },
    Number.MAX_VALUE,
  ]) {
    assert.equal(ChartTime.formatDallasAxisTick(time, 3), null);
    assert.equal(ChartTime.formatDallasCrosshair(time), "");
  }
});
