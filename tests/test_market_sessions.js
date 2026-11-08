const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const MarketSessions = require("../site/market-sessions.js");

test("ranks the seven major sessions from most to least important", () => {
  assert.deepEqual(
    MarketSessions.SESSIONS.map((session) => [session.rank, session.name]),
    [[1, "New York"], [2, "Chicago"], [3, "London"], [4, "Tokyo"], [5, "Hong Kong"], [6, "Frankfurt"], [7, "Sydney"]]
  );
});

test("observed reaction evidence replaces opinion ranking only for qualified sessions", () => {
  const data = {
    sessions: [
      { key: "london", observed_rank: 1, evidence_status: "measured", horizons: { "60": { n: 42, median_abs_move_pct: 0.5 } } },
      { key: "new-york", observed_rank: 2, evidence_status: "measured", horizons: { "60": { n: 42, median_abs_move_pct: 0.4 } } },
    ],
  };
  const ranked = MarketSessions.rankSessions(MarketSessions.SESSIONS, data);
  assert.deepEqual(ranked.slice(0, 3).map((session) => session.key), ["london", "new-york", "cme-equity"]);
  assert.match(MarketSessions.evidenceLabel(data.sessions[0]), /Observed #1.*0\.50%.*n=42/);
  assert.match(MarketSessions.evidenceLabel({ horizons: { "60": { n: 8 } }, evidence_status: "limited" }), /need measured 20\+/);
  assert.match(MarketSessions.coverageLabel({
    asset: "btc",
    coverage_start_utc: "2026-09-08T00:00:00Z",
    coverage_end_utc: "2026-11-07T00:00:00Z",
  }), /Coinbase Exchange · one crypto venue · 60-day sample/);
  assert.match(MarketSessions.coverageLabel({
    asset: "spy",
    coverage_start_utc: "2024-11-07T00:00:00Z",
    coverage_end_utc: "2026-11-06T00:00:00Z",
  }), /Alpaca IEX · one U\.S\. exchange · 729-day sample/);
});

test("keeps two volatility leaders expanded while clearly marking a fallback as provisional", () => {
  const measured = {
    sessions: [
      { key: "london", observed_rank: 1, evidence_status: "measured", horizons: { "60": { n: 42, median_abs_move_pct: 0.5 } } },
      { key: "new-york", observed_rank: 2, evidence_status: "measured", horizons: { "60": { n: 42, median_abs_move_pct: 0.4 } } },
    ],
  };
  const leaders = MarketSessions.topVolatilitySessions(MarketSessions.SESSIONS, measured);
  assert.deepEqual(leaders.map((session) => [session.key, session.measured]), [["london", true], ["new-york", true]]);

  const oneQualified = {
    sessions: [
      { key: "new-york", observed_rank: 1, evidence_status: "measured", horizons: { "60": { n: 498, median_abs_move_pct: 0.22 } } },
    ],
  };
  const provisional = MarketSessions.topVolatilitySessions(MarketSessions.SESSIONS, oneQualified);
  assert.deepEqual(provisional.map((session) => [session.key, session.measured]), [["new-york", true], ["cme-equity", false]]);

  const malformed = {
    sessions: [
      { key: "tokyo", observed_rank: 1, evidence_status: "limited", horizons: { "60": { n: 8, median_abs_move_pct: 9.99 } } },
      { key: "new-york", observed_rank: 2, evidence_status: "measured", horizons: { "60": { n: 42, median_abs_move_pct: 0.4 } } },
    ],
  };
  const failedClosed = MarketSessions.topVolatilitySessions(MarketSessions.SESSIONS, malformed);
  assert.deepEqual(failedClosed.map((session) => [session.key, session.measured]), [["new-york", true], ["cme-equity", false]]);
  assert.equal(MarketSessions.qualifiedEvidence(malformed.sessions[0]), false);
});

test("forward tracker stays collecting until the frozen balanced gate passes", () => {
  const collecting = MarketSessions.forwardDisplay({
    forward_start_utc: "2026-11-08T00:00:00Z",
    summary: {
      evidence_gate_passed: false,
      resolved_edge_events: 12,
      resolved_lower_edge_events: 8,
      resolved_upper_edge_events: 4,
      positive_directional_60m_rate_pct: null,
    },
    events: [],
  });
  assert.match(collecting.status, /COLLECTING FORWARD EVIDENCE · NO EDGE CLAIM/);
  assert.equal(collecting.total, "12 / 50 edge opens");
  assert.match(collecting.note, /Forward recording starts Nov 7, 6:00 PM CST/);

  const qualified = MarketSessions.forwardDisplay({
    forward_start_utc: "2026-11-08T00:00:00Z",
    summary: {
      evidence_gate_passed: true,
      resolved_edge_events: 50,
      resolved_lower_edge_events: 25,
      resolved_upper_edge_events: 25,
      positive_directional_60m_rate_pct: 58.2,
    },
    events: [],
  });
  assert.equal(qualified.qualified, true);
  assert.match(qualified.status, /58\.2% positive at 60m/);
});

test("New York countdown respects both standard and daylight time", () => {
  const newYork = MarketSessions.SESSIONS[0];
  const winter = new Date("2026-11-09T14:29:00Z");
  const summer = new Date("2026-07-06T13:29:00Z");
  assert.equal(MarketSessions.sessionStatus(newYork, winter).nextOpen.toISOString(), "2026-11-09T14:30:00.000Z");
  assert.equal(MarketSessions.sessionStatus(newYork, summer).nextOpen.toISOString(), "2026-07-06T13:30:00.000Z");
  assert.equal(MarketSessions.countdown(MarketSessions.sessionStatus(newYork, winter).nextOpen, winter), "0h 01m 00s");
  assert.match(MarketSessions.localTimeLabel(new Date("2026-11-09T14:30:00Z")), /8:30 AM CST/);
  assert.match(MarketSessions.localTimeLabel(new Date("2026-07-06T13:30:00Z")), /8:30 AM CDT/);
});

test("reports an open session and advances its next regular opening", () => {
  const newYork = MarketSessions.SESSIONS[0];
  const now = new Date("2026-11-09T15:00:00Z");
  const status = MarketSessions.sessionStatus(newYork, now);
  assert.equal(status.isOpen, true);
  assert.equal(status.closesAt.toISOString(), "2026-11-09T21:00:00.000Z");
  assert.equal(status.nextOpen.toISOString(), "2026-11-10T14:30:00.000Z");
});

test("Tokyo and Hong Kong midday recesses are not counted as open", () => {
  const tokyo = MarketSessions.SESSIONS[3];
  const hongKong = MarketSessions.SESSIONS[4];
  const tokyoBreak = MarketSessions.sessionStatus(tokyo, new Date("2026-11-09T03:00:00Z"));
  const hongKongBreak = MarketSessions.sessionStatus(hongKong, new Date("2026-11-09T04:30:00Z"));
  assert.equal(tokyoBreak.isOpen, false);
  assert.equal(tokyoBreak.isBreak, true);
  assert.equal(tokyoBreak.nextOpen.toISOString(), "2026-11-09T03:30:00.000Z");
  assert.equal(hongKongBreak.isOpen, false);
  assert.equal(hongKongBreak.isBreak, true);
  assert.equal(hongKongBreak.nextOpen.toISOString(), "2026-11-09T05:00:00.000Z");
});

test("CME equity futures model the Dallas maintenance halt and weekend reopen", () => {
  const cme = MarketSessions.SESSIONS[1];
  const maintenance = MarketSessions.sessionStatus(cme, new Date("2026-11-10T22:30:00Z"));
  assert.equal(maintenance.isOpen, false);
  assert.equal(maintenance.isBreak, true);
  assert.equal(maintenance.nextOpen.toISOString(), "2026-11-10T23:00:00.000Z");
  const fridayClosed = MarketSessions.sessionStatus(cme, new Date("2026-11-13T23:30:00Z"));
  assert.equal(fridayClosed.isOpen, false);
  assert.equal(fridayClosed.isBreak, false);
  assert.equal(fridayClosed.nextOpen.toISOString(), "2026-11-15T23:00:00.000Z");
});

test("skips weekends and identifies the chronologically next cash open", () => {
  const saturday = new Date("2026-11-07T12:00:00Z");
  const newYork = MarketSessions.sessionStatus(MarketSessions.SESSIONS[0], saturday);
  assert.equal(newYork.nextOpen.toISOString(), "2026-11-09T14:30:00.000Z");
  assert.equal(MarketSessions.countdown(newYork.nextOpen, saturday), "2d 2h 30m 00s");
  assert.equal(MarketSessions.countdown(newYork.nextOpen, new Date("2026-11-07T12:00:01Z")), "2d 2h 29m 59s");
  const fridayAfterNewYork = MarketSessions.marketSnapshot(new Date("2026-11-06T21:30:00Z"));
  assert.equal(fridayAfterNewYork.next.name, "Sydney");
});

test("the shared dashboard clock is present on every asset and discloses holiday limits", () => {
  const siteRoot = path.join(__dirname, "..", "site");
  const html = fs.readFileSync(path.join(siteRoot, "index.html"), "utf8");
  const app = fs.readFileSync(path.join(siteRoot, "app.js"), "utf8");
  assert.match(html, /Market clock · Dallas time/);
  assert.match(html, /All seven major market opens/);
  assert.match(html, /Two volatility leaders/);
  assert.match(html, /market-leader-list/);
  assert.match(html, /Regular sessions only/);
  assert.match(html, /Exchange holidays, half-days, severe weather, or emergency closures can override/);
  assert.match(html, /past movement—not direction, a prediction, or a trade signal/);
  assert.match(html, /market-reaction-coverage/);
  assert.match(html, /Range and market-open research/);
  assert.match(html, /Only post-cutoff observations count/);
  assert.match(html, /role="timer" aria-live="off"/);
  assert.match(html, /market-sessions\.js/);
  assert.match(app, /MarketSessions\.setAsset\(state\.asset\)/);
  assert.match(app, /MarketSessions\.mount\(document, state\.asset\)/);
  assert.match(MarketSessions.assetContext("btc"), /BTC trades 24\/7/);
  assert.match(MarketSessions.assetContext("eth"), /ETH trades 24\/7/);
  assert.match(MarketSessions.assetContext("spy"), /New York is the primary/);
});
