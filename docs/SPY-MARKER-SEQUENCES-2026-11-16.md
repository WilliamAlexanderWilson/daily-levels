# SPY successive-doji-marker study — November 16, 2026

## Answer to the clarified question

This study counts successive **doji markers**, allowing any number of ordinary candles between them. An opposite-color doji resets the run. It tests the next doji after exact marker positions 1–5, plus pooled positions 6+. The existing chart D1/D2 labels still count adjacent doji candles; this research does not change them.

No validated 80% trading rule was established. A high green-marker frequency on the Regular 1m chart is close to its already-high baseline and depends strongly on flat candles being labeled green. The chance of another green marker is different from the chance of a higher market price.

## After five green markers: next doji also green

Primary definition matches the chart: close ≥ open is green, including exact ties. Runs may cross session boundaries. Baseline is the next-doji same-color rate after **any** green marker in the same timeframe/style, including the five-marker subset; it is contextual, not an independent control group.

| Timeframe | Regular after five | Regular baseline | Heikin Ashi after five | HA baseline |
|---|---:|---:|---:|---:|
| 1m | 1,200/1,657 (72.4%) | 17,703/24,933 (71.0%) | 327/663 (49.3%) | 10,636/21,301 (49.9%) |
| 5m | 160/252 (63.5%) | 3,350/5,823 (57.5%) | 99/202 (49.0%) | 3,073/6,120 (50.2%) |
| 10m | 70/135 (51.9%) | 1,771/3,184 (55.6%) | 56/105 (53.3%) | 1,551/3,107 (49.9%) |
| 15m | 47/77 (61.0%) | 1,084/2,007 (54.0%) | 30/64 (46.9%) | 1,053/2,093 (50.3%) |
| 20m | 28/54 (51.9%) | 829/1,597 (51.9%) | 31/55 (56.4%) | 824/1,619 (50.9%) |
| 30m | 11/33 (33.3%) | 517/973 (53.1%) | 9/24 (37.5%) | 523/1,050 (49.8%) |
| 60m | 11/26 (42.3%) | 290/551 (52.6%) | 9/16 (56.2%) | 256/522 (49.0%) |
| 240m | 0/2 (0.0%) | 62/139 (44.6%) | 1/5 (20.0%) | 58/111 (52.3%) |

## Waiting for more green markers

| Timeframe / style | After 1 | After 2 | After 3 | After 4 | After 5 |
|---|---:|---:|---:|---:|---:|
| 1m regular | 4,857/7,230 (67.2%) | 3,316/4,857 (68.3%) | 2,317/3,316 (69.9%) | 1,657/2,317 (71.5%) | 1,200/1,657 (72.4%) |
| 5m regular | 1,450/2,473 (58.6%) | 810/1,450 (55.9%) | 453/810 (55.9%) | 252/453 (55.6%) | 160/252 (63.5%) |
| 10m regular | 808/1,413 (57.2%) | 450/808 (55.7%) | 239/450 (53.1%) | 135/239 (56.5%) | 70/135 (51.9%) |
| 15m regular | 489/923 (53.0%) | 283/489 (57.9%) | 137/283 (48.4%) | 77/137 (56.2%) | 47/77 (61.0%) |
| 1m heikin-ashi | 5,358/10,665 (50.2%) | 2,645/5,358 (49.4%) | 1,334/2,645 (50.4%) | 663/1,334 (49.7%) | 327/663 (49.3%) |
| 5m heikin-ashi | 1,530/3,047 (50.2%) | 745/1,530 (48.7%) | 375/745 (50.3%) | 202/375 (53.9%) | 99/202 (49.0%) |
| 10m heikin-ashi | 757/1,556 (48.7%) | 384/757 (50.7%) | 171/384 (44.5%) | 105/171 (61.4%) | 56/105 (53.3%) |
| 15m heikin-ashi | 536/1,040 (51.5%) | 258/536 (48.1%) | 138/258 (53.5%) | 64/138 (46.4%) | 30/64 (46.9%) |

## Five red markers

| Timeframe | Regular next doji red | Regular baseline | HA next doji red | HA baseline |
|---|---:|---:|---:|---:|
| 1m | 43/123 (35.0%) | 3,764/10,994 (34.2%) | 321/686 (46.8%) | 10,644/21,308 (50.0%) |
| 5m | 33/84 (39.3%) | 1,934/4,408 (43.9%) | 88/193 (45.6%) | 3,031/6,079 (49.9%) |
| 10m | 25/56 (44.6%) | 1,137/2,550 (44.6%) | 60/111 (54.1%) | 1,623/3,179 (51.1%) |
| 15m | 18/34 (52.9%) | 811/1,733 (46.8%) | 40/75 (53.3%) | 1,120/2,159 (51.9%) |
| 20m | 21/37 (56.8%) | 641/1,409 (45.5%) | 18/41 (43.9%) | 744/1,540 (48.3%) |
| 30m | 13/34 (38.2%) | 488/944 (51.7%) | 22/38 (57.9%) | 548/1,075 (51.0%) |
| 60m | 10/21 (47.6%) | 264/525 (50.3%) | 7/15 (46.7%) | 231/497 (46.5%) |
| 240m | 4/8 (50.0%) | 88/165 (53.3%) | 3/7 (42.9%) | 65/119 (54.6%) |

## Flat dojis are a material color convention

An independent direct OHLC calculation reproduced the Regular 1m five-green result: 1,200/1,657. Of those 1,200 next green markers, **719 had open exactly equal to close**; only 481 had close strictly above open. The 1m archive contained 35,928 qualifying dojis, including 13,872 flat dojis, all displayed green by the current rule. A green marker therefore does not necessarily mean the doji closed above its own open.

A separate sensitivity uses flat dojis as neutral: they reset the sequence, are not green or red signal events, and count as non-continuations when they are the next marker. Under that different definition, five strictly green Regular 1m markers were followed by a strictly green doji **47/125 (37.6%)**. This is a different event set and outcome definition, not a revised estimate of the chart-matching 72.4%. No chart coloring has been changed.

## Earlier/later periods and session sensitivity

| Five green markers | All periods | 2020–2023 | 2024–2025 | 2026 |
|---|---:|---:|---:|---:|
| 1m regular, continuous | 1,200/1,657 (72.4%) | 706/936 (75.4%) | 333/469 (71.0%) | 161/252 (63.9%) |
| 1m regular, session | 1,147/1,541 (74.4%) | 691/894 (77.3%) | 310/428 (72.4%) | 146/219 (66.7%) |
| 5m regular, continuous | 160/252 (63.5%) | 97/151 (64.2%) | 42/70 (60.0%) | 20/30 (66.7%) |
| 5m regular, session | 74/115 (64.3%) | 44/67 (65.7%) | 18/30 (60.0%) | 12/18 (66.7%) |
| 15m regular, continuous | 47/77 (61.0%) | 20/38 (52.6%) | 18/25 (72.0%) | 9/14 (64.3%) |
| 15m regular, session | 1/2 (50.0%) | No eligible outcomes | 1/1 (100.0%) | 0/1 (0.0%) |
| 1m heikin-ashi, continuous | 327/663 (49.3%) | 181/345 (52.5%) | 92/192 (47.9%) | 54/126 (42.9%) |

The Regular 1m rate declines from 75.4% in 2020–2023 to 63.9% in 2026. The Regular 5m result (63.5% overall versus 57.5% baseline) is an exploratory candidate, not a validated rule. Its 95% Wilson reference interval is 57.4–69.2%, and only 30 eligible continuous-sequence examples occur in the 2026 partition. Same-session sensitivity prevents overnight sequences and censors markers without another doji that session; those missing outcomes are not scored as losses.

## Elapsed time matters

Elapsed time is wall-clock time from the first same-color marker to the current fifth marker, including overnight/weekend hours. These bins use only information known when the fifth marker closes. The next-marker outcome has no fixed deadline in the continuous analysis.

| Regular, five green | Sequence age ≤60 min | >60–240 min | >240 min |
|---|---:|---:|---:|
| 1m | 476/668 (71.3%) | 587/783 (75.0%) | 137/206 (66.5%) |
| 5m | 1/2 (50.0%) | 49/83 (59.0%) | 110/167 (65.9%) |
| 15m | No eligible outcomes | 3/4 (75.0%) | 44/73 (60.3%) |

## Does actual price rise afterward?

These separate outcomes compare the real close after 1, 3, or 5 candles with the fifth marker candle’s real close. Ties are not favorable. Outcomes crossing a session or missing interval are excluded, and each horizon has its own denominator. They are not executable entry-to-exit returns.

| Five green Regular markers | After 1 candle | After 3 candles | After 5 candles |
|---|---:|---:|---:|
| 1m | 849/1,632 (52.0%) | 778/1,582 (49.2%) | 757/1,536 (49.3%) |
| 5m | 125/250 (50.0%) | 134/242 (55.4%) | 132/234 (56.4%) |
| 10m | 78/134 (58.2%) | 71/126 (56.3%) | 61/120 (50.8%) |
| 15m | 42/74 (56.8%) | 36/64 (56.2%) | 40/60 (66.7%) |

On 1m, the next doji was green 72.4% of the time, yet price was higher three candles later only **778/1,582 (49.2%)**. Marker color alone does not establish a directional trading advantage.

## Method, limitations, and reproducibility

- Source: Alpaca 1-minute historical bars (free IEX feed, regular session); publication cutoff `2026-11-16T20:03:01.787147+00:00`. Coverage July 27, 2020–November 16, 2026; 605,440 1m source bars, aggregated views through 4H. IEX is single-exchange coverage.
- Doji threshold remains body ≤10% of high-low range; zero-range bars are excluded. Regular and HA markers are computed separately using the displayed style. HA history is initialized once at the archive start, matching the existing study.
- Exact fifth marker is counted at its close, without looking ahead to whether the run ends there. Runs longer than five contribute once to exact-five; every sixth-or-later position contributes to the pooled 6+ row. Ordinary candles never reset a marker run.
- Primary runs continue across sessions; sensitivity resets on New York session date changes. Missing IEX bars are not synthesized. Marker sequences refer to observed published markers, so source gaps can hide unobserved market activity.
- Rows record observed events, eligible next-marker outcomes, and censored events. At the end of the archive or a restricted session, no next marker means unknown, not failure. Temporal summaries exclude next-marker outcomes crossing their period boundary, while the all-period row retains them. Sequences may begin before a temporal boundary because those earlier markers were already known.
- Both next-marker direction and fixed-horizon real-price outcomes use only published completed candles. No entries, targets, stops, holding rules, fees, or slippage are modeled.
- The historical data and its partitions have already been inspected. None is an untouched holdout. Multiple timeframes, styles, depths, colors, periods, age bins, and two color conventions were explored. The bins and policies are sensitivity checks, not independent confirmations.
- [Wilson 95% intervals](https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm) in the JSON are binomial reference intervals only. They do not account for overlapping sequences, session dependence, regime shifts, or multiple comparisons. No adjusted statistical significance, causality, or forward accuracy is claimed.

Next research step: freeze a small definition set before collecting new data. Keep the chart-matching and neutral-flat definitions separate. Compare same-period baselines, use session-aware uncertainty estimates, and do not choose the largest scanned percentage as a live signal.

```sh
node scripts/study-spy-marker-sequences.js > /tmp/spy-marker-sequences.json
node --test tests/test_spy_marker_sequences.js
```

The dated JSON freezes this run; rerunning after scheduled archive updates can change results. Tests cover ordinary candles between five markers, opposite-color resets, independent price outcomes, session censoring, publication cutoffs, both candle styles, exact-depth reconciliation, and flat-neutral sensitivity.

[Full machine-readable results](../research/spy_marker_sequences_2026-11-16.json)
