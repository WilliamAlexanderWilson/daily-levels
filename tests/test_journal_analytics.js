const test = require("node:test");
const assert = require("node:assert/strict");
const Journal = require("../site/journal-analytics.js");

const records = [
  { asset: "btc", trade: { direction: "long", price: 100, exitPrice: 104, size: 250, leverage: 2, riskDollars: 20, rewardRisk: 2, rangeLocation: "long-watch", time: 1, exitTime: 2 } },
  { asset: "btc", trade: { direction: "short", price: 100, exitPrice: 102, size: 200, leverage: 2, riskDollars: 20, rewardRisk: 2, rangeLocation: "short-watch", time: 3, exitTime: 4 } },
  { asset: "eth", trade: { direction: "long", price: 10, size: 100, leverage: 1, riskDollars: 10, rewardRisk: 3, rangeLocation: "Unrecorded", time: 5 } },
];

test("journal summary separates open and closed paper positions", () => {
  const result = Journal.summary(records);
  assert.equal(result.total, 3);
  assert.equal(result.closed, 2);
  assert.equal(result.open, 1);
  assert.equal(result.wins, 1);
  assert.equal(result.losses, 1);
  assert.equal(result.winRate, 0.5);
  assert.equal(result.avgPlannedR, 7 / 3);
  assert.equal(result.byAsset.find((row) => row.label === "BTC").closed, 2);
});

test("journal CSV exports explicit paper-trade fields", () => {
  const csv = Journal.csv(records);
  assert.match(csv, /^asset,status,opened_at/);
  assert.match(csv, /"BTC","closed"/);
  assert.match(csv, /"long-watch"/);
});
