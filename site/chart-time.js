(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ChartTime = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const DALLAS_TIME_ZONE = "America/Chicago";

  function dateFromChartTime(time) {
    if (typeof time === "number" && Number.isFinite(time)) return new Date(time * 1000);

    if (typeof time === "string") {
      const businessDay = time.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (businessDay) {
        return new Date(Date.UTC(
          Number(businessDay[1]),
          Number(businessDay[2]) - 1,
          Number(businessDay[3]),
          12
        ));
      }
      const parsed = new Date(time);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    if (time && Number.isInteger(time.year) && Number.isInteger(time.month) && Number.isInteger(time.day)) {
      return new Date(Date.UTC(time.year, time.month - 1, time.day, 12));
    }

    return null;
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
    const date = dateFromChartTime(time);
    if (!date) return null;
    const parts = dallasParts(date);

    if (tickMarkType === 0) return parts.year;
    if (tickMarkType === 1) return parts.month;
    if (tickMarkType === 2) return `${parts.month} ${parts.day}`;

    const minute = parts.minute === "00" ? "" : `:${parts.minute}`;
    return `${parts.hour}${minute} ${parts.dayPeriod}`;
  }

  function formatDallasCrosshair(time) {
    const date = dateFromChartTime(time);
    if (!date) return "";
    return new Intl.DateTimeFormat("en-US", {
      timeZone: DALLAS_TIME_ZONE,
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZoneName: "short",
    }).format(date);
  }

  return {
    DALLAS_TIME_ZONE,
    dateFromChartTime,
    formatDallasAxisTick,
    formatDallasCrosshair,
  };
});
