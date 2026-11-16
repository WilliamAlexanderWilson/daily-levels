#!/usr/bin/env node
"use strict";

// Descriptive chart research only. No entry, stop, target, costs, or trade
// outcome is inferred from a candle's next close.
const fs = require("node:fs");
const path = require("node:path");
const DojiStudy = require("../site/doji-study.js");
const CandleStyle = require("../site/candle-style.js");

const SITE_DATA = path.join(__dirname, "..", "site", "data");
const TIMEFRAMES = [1, 5, 10, 15, 20, 30, 60, 240];
const STREAKS = [1, 2, 3, 4, 5, "6+"];
const RECENT_START = Date.parse("2024-01-01T00:00:00Z") / 1000;

function rate(successes, total) {
  return total ? Number((successes / total).toFixed(4)) : null;
}

function wilson95(successes, total) {
  if (!total) return null;
  const z = 1.96;
  const p = successes / total;
  const denominator = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / denominator;
  const margin = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denominator;
  return [Number((center - margin).toFixed(4)), Number((center + margin).toFixed(4))];
}

function loadArchive(minutes, manifest) {
  const entries = manifest.timeframes[String(minutes)] || [];
  if (!entries.length) throw new Error(`Missing ${minutes}m archive`);
  const byTime = new Map();
  for (const entry of entries) {
    const bars = JSON.parse(fs.readFileSync(path.join(SITE_DATA, entry.path)));
    if (bars.length !== entry.count || bars[0]?.time !== entry.first
        || bars[bars.length - 1]?.time !== entry.last) {
      throw new Error(`Archive manifest does not match ${entry.path}`);
    }
    for (const bar of bars) {
      if (byTime.has(bar.time)) throw new Error(`Duplicate ${minutes}m bar at ${bar.time}`);
      byTime.set(bar.time, bar);
    }
  }
  const bars = [...byTime.values()].sort((left, right) => left.time - right.time);
  return { bars, months: entries.length };
}

function emptyCount() {
  return { events: 0, nextCloseFavorable: 0, nextBarSameColor: 0, nextSameColorDoji: 0 };
}

function analyze(minutes, style, sourceBars, completedThroughUnix) {
  if (!Number.isFinite(completedThroughUnix)) throw new Error("A valid publication cutoff is required");
  for (let index = 0; index < sourceBars.length; index += 1) {
    const bar = sourceBars[index];
    if (![bar.time, bar.open, bar.high, bar.low, bar.close].every(Number.isFinite)
        || bar.low <= 0 || bar.high < Math.max(bar.open, bar.close, bar.low)
        || bar.low > Math.min(bar.open, bar.close)
        || (index > 0 && bar.time <= sourceBars[index - 1].time)) {
      throw new Error("Invalid or unordered archive candle");
    }
  }
  const bars = sourceBars.filter((bar) => bar.time <= completedThroughUnix);
  const matches = DojiStudy.findCompleted(bars, {
    intervalMinutes: minutes,
    completedThroughUnix,
    timeIsClose: true,
    style,
  });
  const byTime = new Map(matches.map((bar) => [bar.time, bar]));
  const displayed = CandleStyle.forStyle(bars, style);
  const baseline = new Map(["green", "red"].map((direction) => [direction,
    { timeframeMinutes: minutes, style, direction, events: 0, nextCloseFavorable: 0 }]));
  const rows = new Map();
  for (const direction of ["green", "red"]) {
    for (const streak of STREAKS) {
      rows.set(`${direction}|${streak}`, {
        direction, streak, ...emptyCount(), early: emptyCount(), recent: emptyCount(),
      });
    }
  }

  for (let index = 0; index < bars.length - 1; index += 1) {
    const current = bars[index];
    const next = bars[index + 1];
    const signal = byTime.get(current.time);
    if (next.time - current.time <= 0 || next.time - current.time > minutes * 60) continue;
    if (!signal) {
      const shown = displayed[index];
      if (shown.high <= shown.low) continue;
      const direction = shown.close >= shown.open ? "green" : "red";
      const ordinary = baseline.get(direction);
      ordinary.events += 1;
      ordinary.nextCloseFavorable += Number(direction === "green"
        ? next.close > current.close : next.close < current.close);
      continue;
    }
    const direction = signal.close >= signal.open ? "green" : "red";
    const streak = signal.streak >= 6 ? "6+" : signal.streak;
    const row = rows.get(`${direction}|${streak}`);
    const period = current.time < RECENT_START ? row.early : row.recent;
    const closeFavorable = direction === "green"
      ? next.close > current.close : next.close < current.close;
    const sameColor = direction === "green"
      ? next.close >= next.open : next.close < next.open;
    const nextDoji = byTime.get(next.time)?.streak === signal.streak + 1;
    for (const count of [row, period]) {
      count.events += 1;
      count.nextCloseFavorable += Number(closeFavorable);
      count.nextBarSameColor += Number(sameColor);
      count.nextSameColorDoji += Number(nextDoji);
    }
  }

  return { baseline: [...baseline.values()], rows: [...rows.values()].map((row) => ({
    timeframeMinutes: minutes,
    style,
    ...row,
    nextCloseFavorableRate: rate(row.nextCloseFavorable, row.events),
    nextCloseFavorableWilson95: wilson95(row.nextCloseFavorable, row.events),
    nextBarSameColorRate: rate(row.nextBarSameColor, row.events),
    nextSameColorDojiRate: rate(row.nextSameColorDoji, row.events),
  })) };
}

function buildReport() {
  const manifest = JSON.parse(fs.readFileSync(path.join(SITE_DATA, "archive", "spy", "manifest.json")));
  const currentChart = JSON.parse(fs.readFileSync(path.join(SITE_DATA, "spy_chart.json")));
  const cutoff = Date.parse(currentChart.generated_at_utc) / 1000;
  const rows = [];
  const baselines = [];
  const coverage = [];
  for (const minutes of TIMEFRAMES) {
    const { bars, months } = loadArchive(minutes, manifest);
    const completed = bars.filter((bar) => bar.time <= cutoff);
    if (!completed.length) throw new Error(`No completed ${minutes}m archive bars`);
    coverage.push({ timeframeMinutes: minutes, months, bars: completed.length,
      first: completed[0].time, last: completed[completed.length - 1].time });
    for (const style of ["regular", "heikin-ashi"]) {
      const result = analyze(minutes, style, bars, cutoff);
      rows.push(...result.rows);
      baselines.push(...result.baseline);
    }
  }

  return {
    schemaVersion: 2,
    title: "SPY doji streak descriptive study v2",
    source: manifest.source,
    sourceGeneratedAtUtc: currentChart.generated_at_utc,
    method: {
      bodyToRangeMaximum: DojiStudy.MAX_BODY_RATIO,
      streak: "Exact D1, D2, ... position among consecutive completed same-color dojis in the selected candle style; non-doji, opposite color, missing interval, and session gaps reset the count.",
      observation: "Next available published bar only when its close timestamp is within one selected interval; overnight and missing-bar transitions are excluded.",
      nextCloseFavorable: "For green, next real SPY close > signal real SPY close; for red, next real SPY close < signal real SPY close. Ties count as not favorable. This is not an executable trade result.",
      nextBarSameColor: "Next real SPY candle has the streak color, using close >= open for green and close < open for red.",
      nextSameColorDoji: "Next displayed candle is another same-color doji, extending the streak.",
      baseline: "Non-doji candles of the same displayed color, timeframe, and style with the same eligible next-bar rule. Flat no-range bars are excluded. This is a descriptive comparison, not a matched or causal test.",
      earlyRecentBoundaryUtc: "2024-01-01T00:00:00Z",
      uncertainty: "Wilson 95% intervals are descriptive binomial reference intervals; serial dependence and scanning many cells can make them too optimistic. No rule was selected or prospectively validated.",
    },
    coverage,
    baselines,
    rows,
  };
}

if (require.main === module) {
  process.stdout.write(`${JSON.stringify(buildReport(), null, process.argv.includes("--compact") ? 0 : 2)}\n`);
}
module.exports = { analyze, buildReport, wilson95 };
