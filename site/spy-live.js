(function (root, factory) {
  const sessions = typeof module === "object" && module.exports
    ? require("./market-sessions.js") : root.MarketSessions;
  const api = factory(sessions);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SpyLive = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (Sessions) {
  "use strict";

  const INTERVALS = [1, 5, 10, 15, 20, 30, 60, 240];
  const STREAM_URL = "wss://stream.data.alpaca.markets/v2/iex";
  const REST_URL = "https://data.alpaca.markets/v2/stocks/SPY/bars";
  const NY = Sessions.SESSIONS.find((session) => session.key === "new-york");

  function normalizeBar(row) {
    if (!row || (row.S && row.S !== "SPY")) return null;
    const start = Date.parse(row.t) / 1000;
    if (!Number.isInteger(start) || start % 60 !== 0
        || ![row.o, row.h, row.l, row.c, row.v].every(Number.isFinite)
        || row.l <= 0 || row.v < 0 || row.h < Math.max(row.o, row.c, row.l)
        || row.l > Math.min(row.o, row.c)) return null;
    // Alpaca timestamps the minute's OPEN; Range Desk timestamps its CLOSE.
    return { time: start + 60, open: row.o, high: row.h, low: row.l, close: row.c, volume: row.v };
  }

  function bucketForMinute(closeTime, minutes) {
    if (!INTERVALS.includes(minutes) || !Number.isFinite(closeTime)) return null;
    const start = new Date((closeTime - 60) * 1000);
    const parts = Sessions.zonedParts(start, "America/New_York");
    const date = Sessions.calendarDate(parts, 0);
    const schedule = Sessions.verifiedSchedule(NY, date);
    if (date.weekday === 0 || date.weekday === 6 || schedule.closed) return null;
    const minute = parts.hour * 60 + parts.minute;
    const openMinute = 570;
    const closeMinute = schedule.closeHour * 60 + schedule.closeMinute;
    if (minute < openMinute || minute >= closeMinute) return null;
    const sessionStart = Sessions.zonedDateTimeToUtc({ ...date, hour: 9, minute: 30, second: 0 }, "America/New_York").getTime() / 1000;
    const offset = Math.floor((minute - openMinute) / minutes) * minutes;
    return {
      start: sessionStart + offset * 60,
      time: sessionStart + Math.min(offset + minutes, closeMinute - openMinute) * 60,
      calendarVerified: schedule.verified,
    };
  }

  function aggregate(minutes, source, completedThrough, coverageStart = -Infinity) {
    const buckets = new Map();
    for (const bar of [...source].sort((a, b) => a.time - b.time)) {
      if (bar.time > completedThrough) continue;
      const bucket = bucketForMinute(bar.time, minutes);
      if (!bucket || bucket.start < coverageStart || bucket.time > completedThrough) continue;
      const existing = buckets.get(bucket.time);
      if (!existing) buckets.set(bucket.time, { ...bar, time: bucket.time });
      else {
        existing.high = Math.max(existing.high, bar.high);
        existing.low = Math.min(existing.low, bar.low);
        existing.close = bar.close;
        existing.volume = (existing.volume || 0) + (bar.volume || 0);
      }
    }
    return [...buckets.values()];
  }

  function mergeBars(existing, incoming) {
    const byTime = new Map(existing.map((bar) => [bar.time, bar]));
    for (const bar of incoming) byTime.set(bar.time, bar);
    return [...byTime.values()].sort((a, b) => a.time - b.time);
  }

  function mergeTimeframes(existing, minuteBars, completedThrough, coverageStart) {
    return Object.fromEntries(INTERVALS.map((minutes) => [String(minutes),
      mergeBars(existing[String(minutes)] || [], aggregate(minutes, minuteBars, completedThrough, coverageStart)),
    ]));
  }

  function parseMessages(data) {
    let rows;
    try { rows = typeof data === "string" ? JSON.parse(data) : data; } catch (_) { return []; }
    if (!Array.isArray(rows)) return [];
    return rows.filter((row) => row && typeof row === "object");
  }

  function liveViewport(range, oldCount, newCount) {
    if (!range) return null;
    const followsLatest = oldCount > 0 && range.to >= oldCount - 2 && range.to <= oldCount + 20;
    const added = followsLatest ? newCount - oldCount : 0;
    return { from: range.from + added, to: range.to + added };
  }

  return { INTERVALS, STREAM_URL, REST_URL, normalizeBar, bucketForMinute, aggregate, mergeBars, mergeTimeframes, parseMessages, liveViewport };
});
