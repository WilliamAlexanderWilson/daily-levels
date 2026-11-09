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

  // Alert eligibility uses only exchange calendars that have been checked
  // against the linked official sources. Normal session clocks can remain
  // visible outside this window, but an unverified calendar can never satisfy
  // the setup-alert timing condition.
  const VERIFIED_SESSION_CALENDARS = {
    "new-york": {
      source: "https://www.nyse.com/trade/hours-calendars",
      years: {
        2026: {
          closed: ["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25"],
          earlyClose: { "2026-11-27": [13, 0], "2026-12-24": [13, 0] },
        },
        2027: {
          closed: ["2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24"],
          earlyClose: { "2027-11-26": [13, 0] },
        },
      },
    },
    london: {
      source: "https://www.londonstockexchange.com/trade/trading-access/business-days",
      years: {
        2026: {
          verifiedFrom: "2026-08-31",
          closed: ["2026-08-31", "2026-12-25", "2026-12-28"],
          earlyClose: { "2026-12-24": [12, 30], "2026-12-31": [12, 30] },
        },
        2027: {
          closed: ["2027-01-01", "2027-03-26", "2027-03-29", "2027-05-03", "2027-05-31", "2027-08-30", "2027-12-27", "2027-12-28"],
          earlyClose: { "2027-12-24": [12, 30], "2027-12-31": [12, 30] },
        },
      },
    },
    "hong-kong": {
      source: "https://www.hkex.com.hk/News/HKEX-Calendar?sc_lang=en",
      years: {
        2026: {
          closed: ["2026-01-01", "2026-02-17", "2026-02-18", "2026-02-19", "2026-04-03", "2026-04-06", "2026-04-07", "2026-05-01", "2026-05-25", "2026-06-19", "2026-07-01", "2026-10-01", "2026-10-19", "2026-12-25"],
          earlyClose: { "2026-02-16": [12, 0], "2026-12-24": [12, 0], "2026-12-31": [12, 0] },
        },
        2027: {
          closed: ["2027-01-01", "2027-02-08", "2027-02-09", "2027-03-26", "2027-03-29", "2027-04-05", "2027-05-13", "2027-06-09", "2027-07-01", "2027-09-16", "2027-10-01", "2027-10-08", "2027-12-27"],
          earlyClose: { "2027-02-05": [12, 0], "2027-12-24": [12, 0], "2027-12-31": [12, 0] },
        },
      },
    },
  };

  let mountedDocument = null;
  let activeAsset = "btc";
  let clockTimer = null;
  const reactionData = Object.create(null);
  const reactionRequests = Object.create(null);
  const forwardData = Object.create(null);
  const forwardRequests = Object.create(null);

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

  function calendarDateKey(parts) {
    return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  }

  function verifiedSchedule(session, date) {
    const calendar = VERIFIED_SESSION_CALENDARS[session.key];
    const year = calendar?.years?.[date.year];
    const dateKey = calendarDateKey(date);
    const verified = Boolean(year)
      && (!year.verifiedFrom || dateKey >= year.verifiedFrom)
      && (!year.verifiedThrough || dateKey <= year.verifiedThrough);
    const earlyClose = verified ? year.earlyClose?.[dateKey] : null;
    return {
      verified,
      closed: verified && year.closed.includes(dateKey),
      closeHour: earlyClose ? earlyClose[0] : session.closeHour,
      closeMinute: earlyClose ? earlyClose[1] : session.closeMinute,
      isEarlyClose: Boolean(earlyClose),
      source: calendar?.source || session.source,
    };
  }

  function tradingDate(session, parts, initialOffset, direction) {
    for (let step = 0; step <= 370; step += 1) {
      const candidate = calendarDate(parts, initialOffset + (step * direction));
      if (candidate.weekday < 1 || candidate.weekday > 5) continue;
      const schedule = verifiedSchedule(session, candidate);
      if (!schedule.verified || !schedule.closed) return { date: candidate, schedule };
    }
    throw new Error("Unable to locate the next trading date");
  }

  function nextWeekdayDate(parts, minimumOffset) {
    for (let offset = minimumOffset; offset <= minimumOffset + 7; offset += 1) {
      const candidate = calendarDate(parts, offset);
      if (candidate.weekday >= 1 && candidate.weekday <= 5) return candidate;
    }
    throw new Error("Unable to locate the next regular trading weekday");
  }

  function previousWeekdayDate(parts, maximumOffset = -1) {
    for (let offset = maximumOffset; offset >= maximumOffset - 7; offset -= 1) {
      const candidate = calendarDate(parts, offset);
      if (candidate.weekday >= 1 && candidate.weekday <= 5) return candidate;
    }
    throw new Error("Unable to locate the previous regular trading weekday");
  }

  function sessionStatus(session, now = new Date()) {
    if (session.kind === "cme-equity-futures") return cmeEquityFuturesStatus(session, now);
    const local = zonedParts(now, session.timeZone);
    const today = calendarDate(local, 0);
    const isWeekday = today.weekday >= 1 && today.weekday <= 5;
    const todaySchedule = verifiedSchedule(session, today);
    const isTradingDay = isWeekday && (!todaySchedule.verified || !todaySchedule.closed);
    const todayOpen = zonedDateTimeToUtc({ ...today, hour: session.openHour, minute: session.openMinute }, session.timeZone);
    const todayClose = zonedDateTimeToUtc({ ...today, hour: todaySchedule.closeHour, minute: todaySchedule.closeMinute }, session.timeZone);
    const breakStart = Number.isFinite(session.breakStartHour)
      ? zonedDateTimeToUtc({ ...today, hour: session.breakStartHour, minute: session.breakStartMinute }, session.timeZone)
      : null;
    const breakEnd = Number.isFinite(session.breakEndHour)
      ? zonedDateTimeToUtc({ ...today, hour: session.breakEndHour, minute: session.breakEndMinute }, session.timeZone)
      : null;
    const tomorrow = tradingDate(session, local, 1, 1);
    const nextRegularOpen = zonedDateTimeToUtc({ ...tomorrow.date, hour: session.openHour, minute: session.openMinute }, session.timeZone);
    const calendarMetadata = {
      calendarVerified: todaySchedule.verified,
      nextOpenCalendarVerified: tomorrow.schedule.verified,
      isEarlyClose: todaySchedule.isEarlyClose,
      calendarSource: todaySchedule.source,
    };
    if (isTradingDay && breakStart && breakEnd && now >= breakStart && now < breakEnd && now < todayClose) {
      return {
        isOpen: false,
        isBreak: true,
        breakKind: "midday",
        openedAt: todayOpen,
        lastOpenedAt: todayOpen,
        lastClosedAt: null,
        closesAt: null,
        finalCloseAt: todayClose,
        nextOpen: breakEnd,
        nextRegularOpen,
        ...calendarMetadata,
      };
    }
    if (isTradingDay && now >= todayOpen && now < todayClose) {
      return {
        isOpen: true,
        isBreak: false,
        pausesAtBreak: Boolean(breakStart && now < breakStart),
        openedAt: todayOpen,
        lastOpenedAt: todayOpen,
        lastClosedAt: null,
        closesAt: breakStart && now < breakStart ? breakStart : todayClose,
        finalCloseAt: todayClose,
        nextOpen: breakStart && breakEnd && now < breakStart
          ? breakEnd
          : nextRegularOpen,
        nextRegularOpen,
        ...calendarMetadata,
      };
    }
    const nextTrading = isTradingDay && now < todayOpen
      ? { date: today, schedule: todaySchedule }
      : tradingDate(session, local, 1, 1);
    const previousTrading = isTradingDay && now >= todayClose
      ? { date: today, schedule: todaySchedule }
      : tradingDate(session, local, -1, -1);
    const previousOpen = zonedDateTimeToUtc({ ...previousTrading.date, hour: session.openHour, minute: session.openMinute }, session.timeZone);
    const previousClose = zonedDateTimeToUtc({
      ...previousTrading.date,
      hour: previousTrading.schedule.closeHour,
      minute: previousTrading.schedule.closeMinute,
    }, session.timeZone);
    const upcomingOpen = zonedDateTimeToUtc({ ...nextTrading.date, hour: session.openHour, minute: session.openMinute }, session.timeZone);
    return {
      isOpen: false,
      isBreak: false,
      openedAt: null,
      lastOpenedAt: previousOpen,
      lastClosedAt: previousClose,
      closesAt: null,
      finalCloseAt: null,
      nextOpen: upcomingOpen,
      nextRegularOpen: upcomingOpen,
      calendarVerified: todaySchedule.verified,
      nextOpenCalendarVerified: nextTrading.schedule.verified,
      isEarlyClose: todaySchedule.isEarlyClose,
      calendarSource: todaySchedule.source,
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

    const closedStatus = (lastOpen, lastClose, nextOpen, isBreak = false, finalCloseAt = null, breakKind = null) => ({
      isOpen: false, isBreak, breakKind, openedAt: null, lastOpenedAt: lastOpen, lastClosedAt: lastClose,
      closesAt: null, finalCloseAt, nextOpen, nextRegularOpen: nextOpen,
    });
    const openStatus = (openedAt, closesAt, nextOpen, pausesAtBreak = false) => ({
      isOpen: true, isBreak: false, pausesAtBreak, openedAt, lastOpenedAt: openedAt,
      lastClosedAt: null, closesAt, finalCloseAt: closesAt, nextOpen, nextRegularOpen: nextOpen,
    });
    const priorThursday = () => {
      const fridayOffset = today.weekday === 6 ? -1 : today.weekday === 0 ? -2 : 0;
      const friday = calendarDate(local, fridayOffset);
      return { open: at(calendarDate(friday, -1), 17), close: at(friday, 16) };
    };

    if (today.weekday === 6) {
      const prior = priorThursday();
      return closedStatus(prior.open, prior.close, at(calendarDate(local, 1), 17));
    }
    if (today.weekday === 0) {
      if (now < todayOpen) {
        const prior = priorThursday();
        return closedStatus(prior.open, prior.close, todayOpen);
      }
      return openStatus(todayOpen, at(calendarDate(local, 1), 16), at(calendarDate(local, 1), 17));
    }
    if (today.weekday >= 1 && today.weekday <= 4) {
      if (now < todayClose) {
        const previousOpen = at(calendarDate(local, -1), 17);
        return openStatus(previousOpen, todayClose, todayOpen, true);
      }
      if (now < todayOpen) {
        return closedStatus(
          at(calendarDate(local, -1), 17),
          todayClose,
          todayOpen,
          true,
          at(calendarDate(local, 1), 16),
          "maintenance"
        );
      }
      const tomorrow = calendarDate(local, 1);
      return openStatus(todayOpen, at(tomorrow, 16), today.weekday === 4 ? sundayOpen : at(tomorrow, 17));
    }
    if (now < todayClose) {
      return openStatus(at(calendarDate(local, -1), 17), todayClose, sundayOpen);
    }
    return closedStatus(at(calendarDate(local, -1), 17), todayClose, sundayOpen);
  }

  function durationLabel(totalSeconds) {
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (days) return `${days}d ${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
    return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
  }

  function countdown(target, now = new Date()) {
    return durationLabel(Math.max(0, Math.floor((target.getTime() - now.getTime()) / 1000)));
  }

  function elapsed(since, now = new Date()) {
    return durationLabel(Math.max(0, Math.floor((now.getTime() - since.getTime()) / 1000)));
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

  function sessionTimingText(session, status, now = new Date()) {
    const openedAt = status.openedAt || status.lastOpenedAt;
    const headline = status.isOpen
      ? `OPEN · ${status.pausesAtBreak ? "pauses" : "closes"} in ${countdown(status.closesAt, now)}`
      : status.isBreak
        ? `${status.breakKind === "maintenance" ? "MAINTENANCE" : status.breakKind === "midday" ? "MIDDAY BREAK" : "BREAK"} · reopens in ${countdown(status.nextOpen, now)}`
        : `CLOSED · opens in ${countdown(status.nextRegularOpen, now)}`;
    const activity = `${status.openedAt ? "Opened" : "Last opened"} ${elapsed(openedAt, now)} ago · ${localTimeLabel(openedAt)} Dallas`;
    let schedule;
    if (status.isOpen) {
      schedule = `Close ${localTimeLabel(status.finalCloseAt)} Dallas · Next open ${localTimeLabel(status.nextRegularOpen)} Dallas`;
    } else if (status.isBreak && status.breakKind === "maintenance") {
      schedule = `Reopens ${localTimeLabel(status.nextOpen)} Dallas · Next close ${localTimeLabel(status.finalCloseAt)} Dallas`;
    } else if (status.isBreak) {
      schedule = `Final close ${localTimeLabel(status.finalCloseAt)} Dallas · Next day ${localTimeLabel(status.nextRegularOpen)} Dallas`;
    } else {
      schedule = `Closed ${elapsed(status.lastClosedAt, now)} ago · Next open ${localTimeLabel(status.nextRegularOpen)} Dallas`;
    }
    return { headline, activity, schedule };
  }

  function sessionStateLabel(status) {
    if (status.isOpen) return "OPEN";
    if (status.breakKind === "maintenance") return "MAINTENANCE";
    if (status.breakKind === "midday") return "MIDDAY BREAK";
    return "CLOSED";
  }

  function nextSessionEvent(sessions, now = new Date()) {
    return sessions.map((session) => {
      const status = session.status;
      if (status.isOpen) {
        return {
          session,
          at: status.closesAt,
          action: status.pausesAtBreak ? "pauses" : "closes",
        };
      }
      if (status.isBreak) return { session, at: status.nextOpen, action: "reopens" };
      return { session, at: status.nextRegularOpen || status.nextOpen, action: "opens" };
    }).filter((event) => event.at instanceof Date && Number.isFinite(event.at.getTime()) && event.at > now)
      .sort((left, right) => (left.at - right.at) || (left.session.rank - right.session.rank))[0] || null;
  }

  function marketSnapshot(now = new Date()) {
    const sessions = SESSIONS.map((session) => ({ ...session, status: sessionStatus(session, now) }));
    const closed = sessions.filter((session) => !session.status.isOpen);
    const next = closed.sort((left, right) => {
      const delta = left.status.nextOpen - right.status.nextOpen;
      return delta || left.rank - right.rank;
    })[0] || sessions.slice().sort((left, right) => left.status.nextOpen - right.status.nextOpen)[0];
    return {
      sessions,
      next,
      nextEvent: nextSessionEvent(sessions, now),
      openCount: sessions.filter((session) => session.status.isOpen).length,
    };
  }

  function assetContext(asset) {
    if (asset === "spy") return "SPY focus · New York is the primary cash-session open.";
    return `${asset.toUpperCase()} trades 24/7 · cash opens can still change liquidity and volatility.`;
  }

  function reactionByKey(data) {
    if (!data || !Array.isArray(data.sessions)) return new Map();
    return new Map(data.sessions.map((session) => [session.key, session]));
  }

  function qualifiedEvidence(evidence) {
    const hour = evidence?.horizons?.["60"];
    return Boolean(
      evidence?.evidence_status === "measured"
      && Number.isFinite(evidence.observed_rank)
      && Number.isFinite(hour?.n)
      && hour.n >= 20
      && Number.isFinite(hour?.median_abs_move_pct)
    );
  }

  function rankSessions(sessions, data) {
    const byKey = reactionByKey(data);
    return sessions.slice().sort((left, right) => {
      const leftEvidence = byKey.get(left.key);
      const rightEvidence = byKey.get(right.key);
      const leftObserved = qualifiedEvidence(leftEvidence) ? leftEvidence.observed_rank : null;
      const rightObserved = qualifiedEvidence(rightEvidence) ? rightEvidence.observed_rank : null;
      if (leftObserved !== null && rightObserved !== null) return leftObserved - rightObserved;
      if (leftObserved !== null) return -1;
      if (rightObserved !== null) return 1;
      return left.rank - right.rank;
    });
  }

  function topVolatilitySessions(sessions, data, count = 2) {
    const evidence = reactionByKey(data);
    return rankSessions(sessions, data).slice(0, count).map((session, index) => ({
      ...session,
      evidence: evidence.get(session.key) || null,
      displayRank: index + 1,
      measured: qualifiedEvidence(evidence.get(session.key)),
    }));
  }

  function setupSessionContext(asset = activeAsset, now = new Date(), data = reactionData[asset], approachMinutes = 30) {
    const snapshot = marketSnapshot(now);
    const leaders = topVolatilitySessions(snapshot.sessions, data).filter((session) => session.measured);
    const approachMs = Math.max(0, Number(approachMinutes) || 0) * 60000;
    const active = leaders.filter((session) => session.status.isOpen && session.status.calendarVerified);
    const approaching = leaders.filter((session) => {
      if (session.status.isOpen) return false;
      if (!session.status.nextOpenCalendarVerified) return false;
      const nextOpen = session.status.nextOpen;
      const waitMs = nextOpen instanceof Date ? nextOpen.getTime() - now.getTime() : Infinity;
      return waitMs >= 0 && waitMs <= approachMs;
    });
    const ready = active.length > 0 || approaching.length > 0;
    let detail = "No measured volatility-leading session is active or within 30 minutes.";
    if (!leaders.length) detail = "Measured session evidence is not available yet; timing stays unconfirmed.";
    else if (leaders.every((session) => !session.status.calendarVerified && !session.status.nextOpenCalendarVerified)) {
      detail = "The leaders' official exchange-calendar coverage is not verified for this date; timing stays unconfirmed.";
    }
    else if (active.length) detail = `${active.map((session) => session.name).join(" and ")} ${active.length === 1 ? "is" : "are"} open now.`;
    else if (approaching.length) {
      const first = approaching.slice().sort((left, right) => left.status.nextOpen - right.status.nextOpen)[0];
      detail = `${first.name} opens in ${countdown(first.status.nextOpen, now)}.`;
    }
    return { ready, detail, leaders, active, approaching };
  }

  function evidenceLabel(evidence) {
    const hour = evidence?.horizons?.["60"];
    if (!hour || !hour.n) return "Not enough complete candles to measure";
    if (!qualifiedEvidence(evidence)) return `Not qualified · n=${hour.n} (need measured 20+)`;
    return `Observed #${evidence.observed_rank} · median |60m| ${hour.median_abs_move_pct.toFixed(2)}% · n=${hour.n}`;
  }

  function evidenceTitle(evidence) {
    if (!evidence?.horizons) return "No measured reaction for this source and lookback.";
    const parts = [15, 30, 60, 120].map((minutes) => {
      const item = evidence.horizons[String(minutes)];
      return item?.n ? `${minutes}m ${item.median_abs_move_pct.toFixed(2)}% median absolute move (n=${item.n})` : `${minutes}m unavailable`;
    });
    if (evidence.median_volume_ratio_60m != null) parts.push(`60m volume ${evidence.median_volume_ratio_60m.toFixed(2)}× prior hour`);
    if (evidence.median_range_expansion_60m != null) parts.push(`60m range ${evidence.median_range_expansion_60m.toFixed(2)}× prior hour`);
    return parts.join(" · ");
  }

  function coverageLabel(data) {
    if (!data?.coverage_start_utc || !data?.coverage_end_utc) return "Source scope unavailable.";
    const start = new Date(data.coverage_start_utc);
    const end = new Date(data.coverage_end_utc);
    const days = Math.max(1, Math.round((end - start) / 86400000));
    const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
    const sourceScope = data.asset === "spy"
      ? "Alpaca IEX · one U.S. exchange"
      : "Coinbase Exchange · one crypto venue";
    return `${sourceScope} · ${days}-day sample · ${dateFormat.format(start)}–${dateFormat.format(end)}`;
  }

  async function loadReactionData(asset) {
    if (Object.prototype.hasOwnProperty.call(reactionData, asset)) return reactionData[asset];
    if (reactionRequests[asset]) return reactionRequests[asset];
    reactionRequests[asset] = fetch(`data/${asset}_session_reactions.json`, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(`reaction data ${response.status}`);
        return response.json();
      })
      .then((data) => { reactionData[asset] = data; return data; })
      .catch(() => { reactionData[asset] = null; return null; })
      .finally(() => { delete reactionRequests[asset]; render(); });
    return reactionRequests[asset];
  }

  function forwardDisplay(data) {
    if (!data?.summary) {
      return {
        qualified: false,
        status: "FORWARD TRACKER UNAVAILABLE",
        note: "No forward artifact is available; no evidence is inferred.",
        total: "0 / 50 edge opens",
        sides: "Lower 0 / 20 · Upper 0 / 20",
      };
    }
    const summary = data.summary;
    const start = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
    }).format(new Date(data.forward_start_utc));
    const latest = data.events?.length ? data.events[data.events.length - 1] : null;
    let note = `Forward recording starts ${start}. No post-cutoff events yet.`;
    if (latest) {
      const location = latest.location === "wait" ? "WAIT" : latest.location.replace("-", " ").toUpperCase();
      note = `Latest: ${latest.session_name} · ${location} · ${latest.status.toUpperCase()}.`;
    }
    return {
      qualified: Boolean(summary.evidence_gate_passed),
      status: summary.evidence_gate_passed
        ? `DESCRIPTIVE SAMPLE READY · ${summary.positive_directional_60m_rate_pct.toFixed(1)}% positive at 60m`
        : "COLLECTING FORWARD EVIDENCE · NO EDGE CLAIM",
      note,
      total: `${summary.resolved_edge_events} / 50 edge opens`,
      sides: `Lower ${summary.resolved_lower_edge_events} / 20 · Upper ${summary.resolved_upper_edge_events} / 20`,
    };
  }

  async function loadForwardData(asset) {
    if (Object.prototype.hasOwnProperty.call(forwardData, asset)) return forwardData[asset];
    if (forwardRequests[asset]) return forwardRequests[asset];
    forwardRequests[asset] = fetch(`data/${asset}_range_open_forward.json`, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(`forward data ${response.status}`);
        return response.json();
      })
      .then((data) => { forwardData[asset] = data; return data; })
      .catch(() => { forwardData[asset] = null; return null; })
      .finally(() => { delete forwardRequests[asset]; render(); });
    return forwardRequests[asset];
  }

  function render(now = new Date()) {
    if (!mountedDocument) return;
    const snapshot = marketSnapshot(now);
    const nextEvent = snapshot.nextEvent || { session: snapshot.next, at: snapshot.next.status.nextOpen, action: "opens" };
    const next = nextEvent.session;
    const data = reactionData[activeAsset];
    const evidence = reactionByKey(data);
    const forward = forwardDisplay(forwardData[activeAsset]);
    mountedDocument.getElementById("market-clock-context").textContent = assetContext(activeAsset);
    mountedDocument.getElementById("market-next-name").textContent = `${next.name} ${nextEvent.action} in`;
    mountedDocument.getElementById("market-next-countdown").textContent = countdown(nextEvent.at, now);
    mountedDocument.getElementById("market-next-time").textContent =
      `${localTimeLabel(nextEvent.at)} Dallas · ${exchangeOpenLabel(next, nextEvent.at)} local`;
    mountedDocument.getElementById("market-open-count").textContent = `${snapshot.openCount} of ${snapshot.sessions.length}`;
    const openNames = snapshot.sessions.filter((session) => session.status.isOpen).map((session) => session.name);
    mountedDocument.getElementById("market-open-zones").textContent = openNames.length
      ? `Open now: ${openNames.join(" · ")}`
      : "No major session is open right now";
    const rankingBasis = mountedDocument.getElementById("market-ranking-basis");
    const measuredCount = data?.sessions?.filter(qualifiedEvidence).length || 0;
    rankingBasis.textContent = measuredCount
      ? `${activeAsset.toUpperCase()} observed ranking · median absolute 60m move · ${measuredCount} sessions qualified`
      : "Source-priority order · observed ranking needs at least 20 complete samples";
    const reactionSource = mountedDocument.getElementById("market-reaction-source");
    mountedDocument.getElementById("market-reaction-coverage").textContent = data
      ? coverageLabel(data)
      : "Observed source scope unavailable; showing the default session order.";
    reactionSource.hidden = !data?.source?.url;
    if (data?.source?.url) {
      reactionSource.href = data.source.url;
      reactionSource.title = data.source.note || data.source.name || "Reaction data source";
    }
    const leaderList = mountedDocument.getElementById("market-leader-list");
    leaderList.innerHTML = "";
    for (const session of topVolatilitySessions(snapshot.sessions, data)) {
      const hour = session.evidence?.horizons?.["60"];
      const sampleCount = Number(hour?.n) || 0;
      const move = Number(hour?.median_abs_move_pct);
      const card = mountedDocument.createElement("span");
      card.className = `market-leader ${session.status.isOpen ? "is-open" : "is-closed"} ${session.measured ? "is-measured" : "is-provisional"}`;
      card.title = session.measured
        ? `${session.name}: median absolute 60-minute move ${move.toFixed(2)}% across ${sampleCount} complete observations.`
        : `${session.name}: provisional source-priority position until 20 complete observations are available.`;
      const dot = mountedDocument.createElement("i");
      dot.setAttribute("aria-hidden", "true");
      const name = mountedDocument.createElement("strong");
      name.textContent = session.name;
      const movement = mountedDocument.createElement("small");
      movement.textContent = session.measured && Number.isFinite(move)
        ? `${move.toFixed(2)}% · n=${sampleCount}`
        : "Provisional";
      const state = mountedDocument.createElement("span");
      state.className = "market-leader-state";
      state.textContent = sessionStateLabel(session.status);
      card.append(dot, name, movement, state);
      leaderList.appendChild(card);
    }
    const forwardPanel = mountedDocument.getElementById("range-open-forward");
    forwardPanel.classList.toggle("is-qualified", forward.qualified);
    mountedDocument.getElementById("range-open-forward-status").textContent = forward.status;
    mountedDocument.getElementById("range-open-forward-note").textContent = forward.note;
    mountedDocument.getElementById("range-open-forward-total").textContent = forward.total;
    mountedDocument.getElementById("range-open-forward-sides").textContent = forward.sides;
    const list = mountedDocument.getElementById("market-session-list");
    list.innerHTML = "";
    for (const session of rankSessions(snapshot.sessions, data)) {
      const sessionEvidence = evidence.get(session.key);
      const row = mountedDocument.createElement("article");
      const stateClass = session.status.isOpen ? "is-open" : session.status.isBreak ? "is-break" : "is-closed";
      row.className = `market-session ${stateClass} ${qualifiedEvidence(sessionEvidence) ? "is-measured" : "is-unmeasured"}`;
      const rank = mountedDocument.createElement("span");
      rank.className = "market-session-rank";
      rank.textContent = qualifiedEvidence(sessionEvidence) ? String(sessionEvidence.observed_rank) : "—";
      const identity = mountedDocument.createElement("span");
      const name = mountedDocument.createElement("strong");
      name.textContent = session.name;
      const exchange = mountedDocument.createElement("small");
      exchange.textContent = session.exchange;
      const zoneTime = mountedDocument.createElement("small");
      zoneTime.className = "market-session-zone";
      zoneTime.textContent = `Local time ${exchangeOpenLabel(session, now)}`;
      const observed = mountedDocument.createElement("small");
      observed.className = "market-session-evidence";
      observed.textContent = evidenceLabel(sessionEvidence);
      observed.title = evidenceTitle(sessionEvidence);
      identity.append(name, exchange, zoneTime, observed);
      const timing = mountedDocument.createElement("span");
      timing.className = "market-session-timing";
      const status = mountedDocument.createElement("strong");
      const timingText = sessionTimingText(session, session.status, now);
      status.textContent = timingText.headline;
      const activity = mountedDocument.createElement("small");
      activity.textContent = timingText.activity;
      const schedule = mountedDocument.createElement("small");
      schedule.textContent = timingText.schedule;
      timing.append(status, activity, schedule);
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
    loadReactionData(activeAsset);
    loadForwardData(activeAsset);
  }

  function mount(doc, asset = "btc") {
    mountedDocument = doc;
    activeAsset = asset;
    render();
    loadReactionData(activeAsset);
    loadForwardData(activeAsset);
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = setInterval(() => render(), 1000);
  }

  return {
    SESSIONS,
    VERIFIED_SESSION_CALENDARS,
    assetContext,
    calendarDate,
    calendarDateKey,
    cmeEquityFuturesStatus,
    countdown,
    elapsed,
    exchangeOpenLabel,
    localTimeLabel,
    evidenceLabel,
    evidenceTitle,
    coverageLabel,
    forwardDisplay,
    qualifiedEvidence,
    rankSessions,
    topVolatilitySessions,
    marketSnapshot,
    mount,
    nextSessionEvent,
    nextWeekdayDate,
    previousWeekdayDate,
    render,
    sessionStatus,
    sessionStateLabel,
    sessionTimingText,
    setAsset,
    setupSessionContext,
    verifiedSchedule,
    zonedDateTimeToUtc,
    zonedParts,
  };
});
