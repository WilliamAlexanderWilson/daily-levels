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
    const todayOpen = zonedDateTimeToUtc({ ...today, hour: session.openHour, minute: session.openMinute }, session.timeZone);
    const todayClose = zonedDateTimeToUtc({ ...today, hour: session.closeHour, minute: session.closeMinute }, session.timeZone);
    const breakStart = Number.isFinite(session.breakStartHour)
      ? zonedDateTimeToUtc({ ...today, hour: session.breakStartHour, minute: session.breakStartMinute }, session.timeZone)
      : null;
    const breakEnd = Number.isFinite(session.breakEndHour)
      ? zonedDateTimeToUtc({ ...today, hour: session.breakEndHour, minute: session.breakEndMinute }, session.timeZone)
      : null;
    const tomorrow = nextWeekdayDate(local, 1);
    const nextRegularOpen = zonedDateTimeToUtc({ ...tomorrow, hour: session.openHour, minute: session.openMinute }, session.timeZone);
    if (isWeekday && breakStart && breakEnd && now >= breakStart && now < breakEnd) {
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
      };
    }
    if (isWeekday && now >= todayOpen && now < todayClose) {
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
      };
    }
    const nextDate = isWeekday && now < todayOpen ? today : nextWeekdayDate(local, 1);
    const previousDate = isWeekday && now >= todayClose ? today : previousWeekdayDate(local);
    const previousOpen = zonedDateTimeToUtc({ ...previousDate, hour: session.openHour, minute: session.openMinute }, session.timeZone);
    const previousClose = zonedDateTimeToUtc({ ...previousDate, hour: session.closeHour, minute: session.closeMinute }, session.timeZone);
    const upcomingOpen = zonedDateTimeToUtc({ ...nextDate, hour: session.openHour, minute: session.openMinute }, session.timeZone);
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
    const next = snapshot.next;
    const data = reactionData[activeAsset];
    const evidence = reactionByKey(data);
    const forward = forwardDisplay(forwardData[activeAsset]);
    mountedDocument.getElementById("market-clock-context").textContent = assetContext(activeAsset);
    mountedDocument.getElementById("market-next-name").textContent = `${next.name} ${next.status.isBreak ? "reopens" : "opens"} in`;
    mountedDocument.getElementById("market-next-countdown").textContent = countdown(next.status.nextOpen, now);
    mountedDocument.getElementById("market-next-time").textContent =
      `${localTimeLabel(next.status.nextOpen)} Dallas · ${exchangeOpenLabel(next, next.status.nextOpen)}`;
    mountedDocument.getElementById("market-open-count").textContent = `${snapshot.openCount} of ${snapshot.sessions.length} open now`;
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
      const card = mountedDocument.createElement("article");
      card.className = `market-leader ${session.status.isOpen ? "is-open" : "is-closed"} ${session.measured ? "is-measured" : "is-provisional"}`;

      const header = mountedDocument.createElement("div");
      header.className = "market-leader-card-heading";
      const badge = mountedDocument.createElement("span");
      badge.className = "market-leader-badge";
      badge.textContent = session.measured ? `OBSERVED #${session.evidence.observed_rank}` : `PROVISIONAL #${session.displayRank}`;
      const state = mountedDocument.createElement("span");
      state.className = "market-leader-state";
      state.textContent = sessionStateLabel(session.status);
      header.append(badge, state);

      const identity = mountedDocument.createElement("div");
      identity.className = "market-leader-identity";
      const name = mountedDocument.createElement("strong");
      name.textContent = session.name;
      const exchange = mountedDocument.createElement("small");
      exchange.textContent = session.exchange;
      identity.append(name, exchange);

      const metrics = mountedDocument.createElement("div");
      metrics.className = "market-leader-metrics";
      const movement = mountedDocument.createElement("span");
      movement.innerHTML = session.measured && Number.isFinite(move)
        ? `<small>Median |60m| move</small><strong>${move.toFixed(2)}%</strong><em>n=${sampleCount}</em>`
        : `<small>Median |60m| move</small><strong>Collecting</strong><em>${sampleCount} of 20 minimum</em>`;
      const timing = mountedDocument.createElement("span");
      timing.innerHTML = session.status.isOpen
        ? `<small>${session.status.pausesAtBreak ? "Pauses" : "Closes"} in</small><strong>${countdown(session.status.closesAt, now)}</strong><em>Next open ${localTimeLabel(session.status.nextOpen)}</em>`
        : `<small>${session.status.isBreak ? "Reopens" : "Opens"} in</small><strong>${countdown(session.status.nextOpen, now)}</strong><em>${localTimeLabel(session.status.nextOpen)}</em>`;
      metrics.append(movement, timing);

      if (!session.measured) {
        const note = mountedDocument.createElement("p");
        note.textContent = "Shown by source priority while this session collects enough complete opens for a volatility rank.";
        card.append(header, identity, metrics, note);
      } else {
        card.append(header, identity, metrics);
      }
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
    assetContext,
    calendarDate,
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
    nextWeekdayDate,
    previousWeekdayDate,
    render,
    sessionStatus,
    sessionStateLabel,
    sessionTimingText,
    setAsset,
    zonedDateTimeToUtc,
    zonedParts,
  };
});
