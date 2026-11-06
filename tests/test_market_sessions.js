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
  const fridayAfterNewYork = MarketSessions.marketSnapshot(new Date("2026-11-06T21:30:00Z"));
  assert.equal(fridayAfterNewYork.next.name, "Sydney");
});

test("the shared dashboard clock is present on every asset and discloses holiday limits", () => {
  const siteRoot = path.join(__dirname, "..", "site");
  const html = fs.readFileSync(path.join(siteRoot, "index.html"), "utf8");
  const app = fs.readFileSync(path.join(siteRoot, "app.js"), "utf8");
  assert.match(html, /GLOBAL MARKET CLOCK · DALLAS TIME/);
  assert.match(html, /All seven major market opens/);
  assert.match(html, /Exchange holidays, half-days, severe weather, or emergency closures can override/);
  assert.match(html, /market-sessions\.js/);
  assert.match(app, /MarketSessions\.setAsset\(state\.asset\)/);
  assert.match(app, /MarketSessions\.mount\(document, state\.asset\)/);
  assert.match(MarketSessions.assetContext("btc"), /BTC trades 24\/7/);
  assert.match(MarketSessions.assetContext("eth"), /ETH trades 24\/7/);
  assert.match(MarketSessions.assetContext("spy"), /New York is the primary/);
});
