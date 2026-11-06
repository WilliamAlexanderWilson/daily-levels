(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.MarketSessions = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const SESSIONS = [
    {
      key: "new-york", rank: 1, name: "New York", exchange: "NYSE · Nasdaq",
      timeZone: "America/New_York", openHour: 9, openMinute: 30, closeHour: 16, closeMinute: 0,
      source: "https://www.nyse.com/trade/hours-calendars",
    },
    {
      key: "cme-equity", rank: 2, name: "Chicago", exchange: "CME S&P · Nasdaq futures",
      timeZone: "America/Chicago", kind: "cme-equity-futures",
      source: "https://www.cmegroup.com/markets/equities/sp-500-and-nasdaq-100-futures.html",
    },
    {
      key: "london", rank: 3, name: "London", exchange: "London Stock Exchange",
      timeZone: "Europe/London", openHour: 8, openMinute: 0, closeHour: 16, closeMinute: 30,
      source: "https://www.londonstockexchange.com/en/resources/faqs/personal-investing",
    },
    {
      key: "tokyo", rank: 4, name: "Tokyo", exchange: "Tokyo Stock Exchange",
      timeZone: "Asia/Tokyo", openHour: 9, openMinute: 0, closeHour: 15, closeMinute: 30,
      breakStartHour: 11, breakStartMinute: 30, breakEndHour: 12, breakEndMinute: 30,
      source: "https://www.jpx.co.jp/english/equities/trading/domestic/01.html",
    },
    {
      key: "hong-kong", rank: 5, name: "Hong Kong", exchange: "Hong Kong Exchange",
      timeZone: "Asia/Hong_Kong", openHour: 9, openMinute: 30, closeHour: 16, closeMinute: 0,
      breakStartHour: 12, breakStartMinute: 0, breakEndHour: 13, breakEndMinute: 0,
      source: "https://www.hkex.com.hk/Services/Trading-hours-and-Severe-Weather-Arrangements/Trading-Hours/Securities-Market?sc_lang=en",
    },
    {
      key: "xetra", rank: 6, name: "Frankfurt", exchange: "Xetra",
      timeZone: "Europe/Berlin", openHour: 9, openMinute: 0, closeHour: 17, closeMinute: 30,
      source: "https://www.cashmarket.deutsche-boerse.com/cash-en/trading/trading-calendar-and-trading-hours",
    },
    {
      key: "sydney", rank: 7, name: "Sydney", exchange: "Australian Securities Exchange",
      timeZone: "Australia/Sydney", openHour: 10, openMinute: 0, closeHour: 16, closeMinute: 0,
      source: "https://www.asx.com.au/markets/market-resources/trading-hours-calendar/cash-market-trading-hours",
    },
  ];

  let mountedDocument = null;
  let activeAsset = "btc";
  let clockTimer = null;

  function zonedParts(date, timeZone) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  }

  function zonedDateTimeToUtc(parts, timeZone) {
    const wallClock = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0);
    let guess = wallClock;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const shown = zonedParts(new Date(guess), timeZone);
      const shownClock = Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute, shown.second);
      guess += wallClock - shownClock;
    }
    return new Date(guess);
  }

  function calendarDate(parts, dayOffset) {
    const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + dayOffset));
    return {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      weekday: shifted.getUTCDay(),
    };
  }

  function nextWeekdayDate(parts, minimumOffset) {
    for (let offset = minimumOffset; offset <= minimumOffset + 7; offset += 1) {
      const candidate = calendarDate(parts, offset);
      if (candidate.weekday >= 1 && candidate.weekday <= 5) return candidate;
    }
    throw new Error("Unable to locate the next regular trading weekday");
  }

  function sessionStatus(session, now = new Date()) {
    if (session.kind === "cme-equity-futures") return cmeEquityFuturesStatus(session, now);
    const local = zonedParts(now, session.timeZone);
    const today = calendarDate(local, 0);
    const isWeekday = today.weekday >= 1 && today.weekday <= 5;
    const todayOpen = zonedDateTimeToUtc({ ...today, hour: session.openHour, minute: session.openMinute }, session.timeZone);
    const todayClose = zonedDateTimeToUtc({ ...today, hour: session.closeHour, minute: session.closeMinute }, session.timeZone);
    const breakStart = Number.isFinite(session.breakStartHour)
      ? zonedDateTimeToUtc({ ...today, hour: session.breakStartHour, minute: session.breakStartMinute }, session.timeZone)
      : null;
    const breakEnd = Number.isFinite(session.breakEndHour)
      ? zonedDateTimeToUtc({ ...today, hour: session.breakEndHour, minute: session.breakEndMinute }, session.timeZone)
      : null;
    if (isWeekday && breakStart && breakEnd && now >= breakStart && now < breakEnd) {
      return {
        isOpen: false,
        isBreak: true,
        openedAt: todayOpen,
        closesAt: null,
        nextOpen: breakEnd,
      };
    }
    if (isWeekday && now >= todayOpen && now < todayClose) {
      const tomorrow = nextWeekdayDate(local, 1);
      return {
        isOpen: true,
        isBreak: false,
        pausesAtBreak: Boolean(breakStart && now < breakStart),
        openedAt: todayOpen,
        closesAt: breakStart && now < breakStart ? breakStart : todayClose,
        nextOpen: breakStart && breakEnd && now < breakStart
          ? breakEnd
          : zonedDateTimeToUtc({ ...tomorrow, hour: session.openHour, minute: session.openMinute }, session.timeZone),
      };
    }
    const nextDate = isWeekday && now < todayOpen ? today : nextWeekdayDate(local, 1);
    return {
      isOpen: false,
      isBreak: false,
      openedAt: null,
      closesAt: null,
      nextOpen: zonedDateTimeToUtc({ ...nextDate, hour: session.openHour, minute: session.openMinute }, session.timeZone),
    };
  }

  function cmeEquityFuturesStatus(session, now = new Date()) {
    const local = zonedParts(now, session.timeZone);
    const today = calendarDate(local, 0);
    const at = (date, hour) => zonedDateTimeToUtc({ ...date, hour, minute: 0 }, session.timeZone);
    const todayClose = at(today, 16);
    const todayOpen = at(today, 17);
    const sundayOffset = (7 - today.weekday) % 7;
    const nextSunday = calendarDate(local, sundayOffset || 7);
    const sundayOpen = at(nextSunday, 17);

    if (today.weekday === 6) {
      return { isOpen: false, isBreak: false, openedAt: null, closesAt: null, nextOpen: at(calendarDate(local, 1), 17) };
    }
    if (today.weekday === 0) {
      if (now < todayOpen) return { isOpen: false, isBreak: false, openedAt: null, closesAt: null, nextOpen: todayOpen };
      return {
        isOpen: true, isBreak: false, pausesAtBreak: false, openedAt: todayOpen,
        closesAt: at(calendarDate(local, 1), 16), nextOpen: at(calendarDate(local, 1), 17),
      };
    }
    if (today.weekday >= 1 && today.weekday <= 4) {
      if (now < todayClose) {
        return {
          isOpen: true, isBreak: false, pausesAtBreak: true, openedAt: null,
          closesAt: todayClose, nextOpen: todayOpen,
        };
      }
      if (now < todayOpen) return { isOpen: false, isBreak: true, openedAt: null, closesAt: null, nextOpen: todayOpen };
      const tomorrow = calendarDate(local, 1);
      return {
        isOpen: true, isBreak: false, pausesAtBreak: false, openedAt: todayOpen,
        closesAt: at(tomorrow, 16),
        nextOpen: today.weekday === 4 ? sundayOpen : at(tomorrow, 17),
      };
    }
    if (now < todayClose) {
      return {
        isOpen: true, isBreak: false, pausesAtBreak: false, openedAt: null,
        closesAt: todayClose, nextOpen: sundayOpen,
      };
    }
    return { isOpen: false, isBreak: false, openedAt: null, closesAt: null, nextOpen: sundayOpen };
  }

  function countdown(target, now = new Date()) {
    const totalSeconds = Math.max(0, Math.floor((target.getTime() - now.getTime()) / 1000));
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (days) return `${days}d ${hours}h ${String(minutes).padStart(2, "0")}m`;
    return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
  }

  function localTimeLabel(date) {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: "America/Chicago",
      weekday: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short",
    }).format(date);
  }

  function exchangeOpenLabel(session, date) {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: session.timeZone, hour: "numeric", minute: "2-digit", timeZoneName: "short",
    }).format(date);
  }

  function marketSnapshot(now = new Date()) {
    const sessions = SESSIONS.map((session) => ({ ...session, status: sessionStatus(session, now) }));
    const closed = sessions.filter((session) => !session.status.isOpen);
    const next = closed.sort((left, right) => {
      const delta = left.status.nextOpen - right.status.nextOpen;
      return delta || left.rank - right.rank;
    })[0] || sessions.slice().sort((left, right) => left.status.nextOpen - right.status.nextOpen)[0];
    return { sessions, next, openCount: sessions.filter((session) => session.status.isOpen).length };
  }

  function assetContext(asset) {
    if (asset === "spy") return "SPY focus · New York is the primary cash-session open.";
    return `${asset.toUpperCase()} trades 24/7 · cash opens can still change liquidity and volatility.`;
  }

  function render(now = new Date()) {
    if (!mountedDocument) return;
    const snapshot = marketSnapshot(now);
    const next = snapshot.next;
    mountedDocument.getElementById("market-clock-context").textContent = assetContext(activeAsset);
    mountedDocument.getElementById("market-next-name").textContent = `${next.name} ${next.status.isBreak ? "reopens" : "opens"} in`;
    mountedDocument.getElementById("market-next-countdown").textContent = countdown(next.status.nextOpen, now);
    mountedDocument.getElementById("market-next-time").textContent =
      `${localTimeLabel(next.status.nextOpen)} Dallas · ${exchangeOpenLabel(next, next.status.nextOpen)}`;
    mountedDocument.getElementById("market-open-count").textContent = `${snapshot.openCount} of ${snapshot.sessions.length} open now`;
    const list = mountedDocument.getElementById("market-session-list");
    list.innerHTML = "";
    for (const session of snapshot.sessions) {
      const row = mountedDocument.createElement("article");
      row.className = `market-session ${session.status.isOpen ? "is-open" : "is-closed"}`;
      const rank = mountedDocument.createElement("span");
      rank.className = "market-session-rank";
      rank.textContent = String(session.rank);
      const identity = mountedDocument.createElement("span");
      const name = mountedDocument.createElement("strong");
      name.textContent = session.name;
      const exchange = mountedDocument.createElement("small");
      exchange.textContent = session.exchange;
      identity.append(name, exchange);
      const timing = mountedDocument.createElement("span");
      timing.className = "market-session-timing";
      const status = mountedDocument.createElement("strong");
      status.textContent = session.status.isOpen
        ? `OPEN · ${session.status.pausesAtBreak ? "pauses" : "closes"} in ${countdown(session.status.closesAt, now)}`
        : `${session.status.isBreak ? "MIDDAY BREAK · reopens" : "Opens"} in ${countdown(session.status.nextOpen, now)}`;
      const local = mountedDocument.createElement("small");
      local.textContent = session.status.isOpen
        ? `Next open ${localTimeLabel(session.status.nextOpen)}`
        : localTimeLabel(session.status.nextOpen);
      timing.append(status, local);
      const source = mountedDocument.createElement("a");
      source.href = session.source;
      source.target = "_blank";
      source.rel = "noopener noreferrer";
      source.textContent = "Hours ↗";
      row.append(rank, identity, timing, source);
      list.appendChild(row);
    }
  }

  function setAsset(asset) {
    activeAsset = asset === "eth" || asset === "spy" ? asset : "btc";
    render();
  }

  function mount(doc, asset = "btc") {
    mountedDocument = doc;
    activeAsset = asset;
    render();
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = setInterval(() => render(), 1000);
  }

  return {
    SESSIONS,
    assetContext,
    calendarDate,
    cmeEquityFuturesStatus,
    countdown,
    exchangeOpenLabel,
    localTimeLabel,
    marketSnapshot,
    mount,
    nextWeekdayDate,
    render,
    sessionStatus,
    setAsset,
    zonedDateTimeToUtc,
    zonedParts,
  };
});
