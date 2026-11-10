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

test("returns safe fallbacks for invalid chart times", () => {
  assert.equal(ChartTime.formatDallasAxisTick("not-a-date", 3), null);
  assert.equal(ChartTime.formatDallasCrosshair("not-a-date"), "");
});
