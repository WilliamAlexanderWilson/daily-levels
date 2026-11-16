# SPY doji continuation: exploratory findings, November 16, 2026

**No validated high-probability continuation rule was established.** More same-color dojis did not consistently improve the next-candle frequency. The apparent 88.9% result after three green regular 5m dojis comes from only nine eligible examples, with none in 2026.

## Data and definitions

- Published Alpaca IEX regular-session archive: July 27, 2020–November 16, 2026; source publication 2026-11-16T20:03:01.787147+00:00. The 1m source has 605,440 candles. IEX is single-exchange coverage; these are not independent observations across timeframes.
- Examined all 1m, 5m, 10m, 15m, 20m, 30m, 1H, and 4H views; Regular and Heikin Ashi styles; green/red; exact D1–D5 and D6+. 192 pattern cells, four outcomes, and temporal breakdowns are exploratory comparisons, not independent hypothesis confirmations.
- Doji body is at most 10% of its high-low range. D3 means three adjacent same-color doji candles, not three same-color D markers separated by other candles. The decision uses data available through that candle; it does not require the streak to end at three.
- Green includes close equal to open, matching the chart; red means close below open. Zero-range signal candles are excluded. Missing/overnight next-bar transitions and outcomes beyond the publication cutoff are excluded. No next-day outcome is substituted for a missing next candle.
- Primary outcome: next **real** candle has the streak color. Separate outcomes: next **displayed** candle has that color; next real close moves in that direction from the signal close; next displayed candle is a same-color doji. These are different questions.
- Baseline: non-doji candles of the same displayed color, timeframe, style, and period, with the same eligible next-bar rule. It is not matched for time of day, volatility, trend, or market regime.
- Temporal groups: 2020–2023, 2024–2025, and 2026 through publication. All are previously available historical data, **not untouched holdouts**. Outcomes crossing a group boundary are excluded from group summaries.

## Three green Regular dojis → next real candle green

| Timeframe | Next candle green | Ordinary green-candle baseline | 95% reference interval |
|---|---:|---:|---:|
| 1m | 22/41 (53.7%) | 142,587/269,837 (52.8%) | 38.8–67.9% |
| 5m | 8/9 (88.9%) | 29,014/57,042 (50.9%) | 56.5–98.0% |
| 10m | 3/8 (37.5%) | 14,379/27,980 (51.4%) | 13.7–69.4% |
| 15m | 1/2 (50.0%) | 9,650/18,646 (51.8%) | 9.4–90.5% |
| 20m | 1/4 (25.0%) | 7,502/14,210 (52.8%) | 4.6–69.9% |
| 30m | 1/2 (50.0%) | 4,751/9,074 (52.4%) | 9.4–90.5% |
| 60m | No eligible examples | 2,438/4,561 (53.5%) | — |
| 240m | No eligible examples | 416/770 (54.0%) | — |

## Does waiting longer help? Regular green candles

| Timeframe | After D1 | After D2 | After D3 |
|---|---:|---:|---:|
| 1m | 12,399/23,516 (52.7%) | 560/1,047 (53.5%) | 22/41 (53.7%) |
| 5m | 2,783/5,497 (50.6%) | 128/246 (52.0%) | 8/9 (88.9%) |
| 10m | 1,548/2,941 (52.6%) | 83/156 (53.2%) | 3/8 (37.5%) |
| 15m | 1,012/1,869 (54.1%) | 40/78 (51.3%) | 1/2 (50.0%) |
| 20m | 744/1,447 (51.4%) | 32/69 (46.4%) | 1/4 (25.0%) |
| 30m | 452/850 (53.2%) | 25/43 (58.1%) | 1/2 (50.0%) |
| 60m | 236/452 (52.2%) | 13/20 (65.0%) | No eligible examples |
| 240m | 34/65 (52.3%) | No eligible examples | No eligible examples |

There were no eligible Regular green or red D4/D5 continuation observations in this archive. This does not mean their future probability is zero. Higher timeframes cannot fit three dojis plus an outcome within a regular session in some cases (notably 4H); missing outcomes are not failures.

## Patterns worth distinguishing from validated evidence

- **Green Heikin Ashi 1m D3:** next real candle green 36/55 (65.5%), versus 53.2% after ordinary green HA candles. The next displayed HA candle was green only 29/55 (52.7%); the next real close was higher only 32/55 (58.2%). The real-color Wilson interval is 52.3–76.6%, overlapping the baseline rate. This is a possible research candidate, not an established advantage.
- **Red Regular 30m D2:** next real candle red 19/30 (63.3%), versus 47.9% baseline. But the result fell from 15/19 (78.9%) in 2020–2023 to 2/7 (28.6%) in 2024–2025 and 2/4 (50%) in 2026. The headline percentage is not stable.
- **Green Regular 1m D2:** 560/1,047 (53.5%), versus 52.8% baseline: only about 0.7 percentage points higher despite a much larger sample.

### Chronological checks for selected three-doji patterns

| Pattern | 2020–2023 | 2024–2025 | 2026 |
|---|---:|---:|---:|
| Green regular 1m D3 | 17/28 (60.7%) | 2/9 (22.2%) | 3/4 (75.0%) |
| Green regular 5m D3 | 6/6 (100.0%) | 2/3 (66.7%) | No eligible examples |
| Green heikin-ashi 1m D3 | 18/29 (62.1%) | 8/10 (80.0%) | 10/16 (62.5%) |

## What this establishes—and what it does not

The data supports descriptive conditional frequencies. It does not establish a causal relationship, a reliable 80% prediction, or a profitable trade. Candle direction does not incorporate entry timing, target, stop, holding time, spread, slippage, or costs. Those trade rules remain undefined.

The [Wilson reference intervals](https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm) describe binomial sampling uncertainty. They do not correct for serial dependence, clustered sessions, or searching many patterns. No multiple-comparison-adjusted significance or independent prospective validation is claimed. A wide interval and a tiny denominator must not be presented as a confidence score.

Next useful step: choose and freeze one precise outcome and a small candidate set before observing a genuinely new evaluation window. Compare against same-period baselines, account for session clustering and multiple comparisons, and report all outcomes. Use the existing chart statistics as historical context in the meantime; do not turn the largest scanned percentage into a trade label.

## Reproduce

```sh
node scripts/study-spy-doji-continuation.js > /tmp/spy-doji-continuation.json
node --test tests/test_spy_continuation.js
```

The script reads the currently checked-out archives. Scheduled updates can change subsequent output; the accompanying dated JSON freezes this analysis. All 192 all-period pattern counts reconciled against the existing published study across all four comparable count fields. The new tests cover exact streaks, missing intervals, completion cutoffs, validation, and both candle styles.

[Full counts and temporal baselines](../research/spy_doji_continuation_2026-11-16.json)
