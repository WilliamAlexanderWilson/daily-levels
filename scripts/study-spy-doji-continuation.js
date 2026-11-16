#!/usr/bin/env node
"use strict";
// Exploratory association study. Historical periods have already been examined;
// none is an untouched holdout and no trade outcome is inferred.
const fs = require('node:fs');
const path = require('node:path');
const Doji = require('../site/doji-study.js');
const Style = require('../site/candle-style.js');
const { analyze, wilson95 } = require('./analyze-spy-doji-streaks.js');
const DATA = path.join(__dirname, '../site/data');
const outcomes = ['realSameColor', 'displayedSameColor', 'closeFavorable', 'nextSameColorDoji'];
function counts() { return { n: 0, ...Object.fromEntries(outcomes.map(k => [k, 0])) }; }
function period(time) { const year = new Date(time * 1000).getUTCFullYear(); return year < 2024 ? '2020-2023' : year < 2026 ? '2024-2025' : '2026'; }
function study(bars, minutes, style, cutoff) {
  // Reuse the existing validator before interpreting source OHLC or timestamps.
  analyze(minutes, style, bars, cutoff);
  bars = bars.filter(b => b.time <= cutoff);
  const displayed = Style.forStyle(bars, style);
  const signals = new Map(Doji.findCompleted(bars, { intervalMinutes: minutes, style, timeIsClose: true, completedThroughUnix: cutoff }).map(b => [b.time, b]));
  const rows = new Map();
  for (const direction of ['green', 'red']) for (const streak of ['ordinary', 1, 2, 3, 4, 5, '6+']) for (const p of ['all', '2020-2023', '2024-2025', '2026']) {
    rows.set(`${direction}|${streak}|${p}`, { minutes, style, direction, streak, period: p, ...counts() });
  }
  for (let i = 0; i < bars.length - 1; i++) {
    const current = bars[i], next = bars[i + 1], shown = displayed[i], nextShown = displayed[i + 1];
    if (next.time - current.time > minutes * 60 || shown.high <= shown.low) continue;
    const signal = signals.get(current.time);
    const green = shown.close >= shown.open, direction = green ? 'green' : 'red';
    const streak = signal ? (signal.streak >= 6 ? '6+' : signal.streak) : 'ordinary';
    const values = {
      realSameColor: green === (next.close >= next.open),
      displayedSameColor: green === (nextShown.close >= nextShown.open),
      closeFavorable: green ? next.close > current.close : next.close < current.close,
      nextSameColorDoji: !!signals.get(next.time) && green === (nextShown.close >= nextShown.open),
    };
    // Assign an observation to a period only if its outcome stays in that period.
    const periods = ['all'];
    if (period(current.time) === period(next.time)) periods.push(period(current.time));
    for (const p of periods) {
      const row = rows.get(`${direction}|${streak}|${p}`); row.n++;
      for (const key of outcomes) row[key] += Number(values[key]);
    }
  }
  return [...rows.values()].map(row => ({ ...row, realSameColorWilson95: wilson95(row.realSameColor, row.n) }));
}
function build() {
  const manifest = JSON.parse(fs.readFileSync(path.join(DATA, 'archive/spy/manifest.json')));
  const chart = JSON.parse(fs.readFileSync(path.join(DATA, 'spy_chart.json')));
  const cutoff = Date.parse(chart.generated_at_utc) / 1000;
  const rows = [], coverage = [];
  for (const minutes of [1,5,10,15,20,30,60,240]) {
    const bars = manifest.timeframes[minutes].flatMap(entry => {
      const chunk = JSON.parse(fs.readFileSync(path.join(DATA, entry.path)));
      if (chunk.length !== entry.count || chunk[0]?.time !== entry.first || chunk.at(-1)?.time !== entry.last) throw new Error(`Manifest mismatch: ${entry.path}`);
      return chunk;
    }).sort((a,b) => a.time-b.time);
    coverage.push({minutes, bars: bars.filter(b=>b.time<=cutoff).length, first: bars[0].time, last: bars.filter(b=>b.time<=cutoff).at(-1).time});
    for (const style of ['regular','heikin-ashi']) rows.push(...study(bars,minutes,style,cutoff));
  }
  return { sourceGeneratedAtUtc:chart.generated_at_utc, source:manifest.source, coverage, rows };
}
if (require.main === module) process.stdout.write(JSON.stringify(build(), null, 2)+'\n');
module.exports = {study};
