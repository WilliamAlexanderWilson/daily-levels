(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ChartTime = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const DALLAS_TIME_ZONE = "America/Chicago";

  function validBusinessDay(year, month, day) {
    if (![year, month, day].every(Number.isInteger)) return null;
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(12, 0, 0, 0);
    if (
      date.getUTCFullYear() !== year
      || date.getUTCMonth() !== month - 1
      || date.getUTCDate() !== day
    ) return null;
    return { date, dateOnly: true };
  }

  function parseChartTime(time) {
    if (typeof time === "number" && Number.isFinite(time)) {
      const date = new Date(time * 1000);
      return Number.isFinite(date.getTime()) ? { date, dateOnly: false } : null;
    }

    if (typeof time === "string") {
      const businessDay = time.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (businessDay) {
        return validBusinessDay(
          Number(businessDay[1]),
          Number(businessDay[2]),
          Number(businessDay[3])
        );
      }
      const parsed = new Date(time);
      return Number.isFinite(parsed.getTime()) ? { date: parsed, dateOnly: false } : null;
    }

    if (time && Number.isInteger(time.year) && Number.isInteger(time.month) && Number.isInteger(time.day)) {
      return validBusinessDay(time.year, time.month, time.day);
    }

    return null;
  }

  function dateFromChartTime(time) {
    return parseChartTime(time)?.date || null;
  }

  function dallasParts(date) {
    return Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone: DALLAS_TIME_ZONE,
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  }

  function formatDallasAxisTick(time, tickMarkType) {
    const parsed = parseChartTime(time);
    if (!parsed) return null;
    const parts = dallasParts(parsed.date);

    if (tickMarkType === 0) return parts.year;
    if (tickMarkType === 1) return parts.month;
    if (tickMarkType === 2) return `${parts.month} ${parts.day}`;
    if (parsed.dateOnly) return `${parts.month} ${parts.day}`;

    const minute = parts.minute === "00" ? "" : `:${parts.minute}`;
    return `${parts.hour}${minute} ${parts.dayPeriod}`;
  }

  function formatDallasCrosshair(time) {
    const parsed = parseChartTime(time);
    if (!parsed) return "";
    if (parsed.dateOnly) {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC",
        month: "short",
        day: "numeric",
        year: "numeric",
      }).format(parsed.date);
    }
    return new Intl.DateTimeFormat("en-US", {
      timeZone: DALLAS_TIME_ZONE,
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZoneName: "short",
    }).format(parsed.date);
  }

  return {
    DALLAS_TIME_ZONE,
    dateFromChartTime,
    parseChartTime,
    formatDallasAxisTick,
    formatDallasCrosshair,
  };
});
