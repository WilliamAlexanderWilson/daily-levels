# SPY doji streaks: descriptive snapshot

Snapshot: SPY export published 2026-11-16 16:32 UTC. The reproducible counts
come from `node scripts/analyze-spy-doji-streaks.js` and the frozen artifact
[`research/spy_doji_streaks_2026-11-16.json`](../research/spy_doji_streaks_2026-11-16.json).
The published monthly archives cover July 2020 through November 2026. They
contain Alpaca's regular-session IEX bars, a subset of US market activity
([Alpaca's feed explanation](https://docs.alpaca.markets/us/docs/market-data-faq)).

## Question and measurement

For each timeframe and candle style, a doji has a body no larger than 10% of
its full high-low range. D1 is the first completed doji. D2, D3, and later
labels require consecutive completed dojis of the same displayed color. A
non-doji, opposite color, missing bar interval, or overnight gap resets the
count. Events at the exact streak position are counted once; D3 means the
third doji, not any streak of at least three.

The table measures whether the **next real SPY close** moved in the streak's
direction from the signal bar's real close. The next bar must arrive within
one selected timeframe interval, so overnight and missing-bar transitions
are excluded. A tie counts as not favorable. This is an observed price move,
not a trade win: there is no executable entry, target, stop, holding limit,
spread, slippage, or option premium in this measurement.

| Regular candles | D1 | D2 | D3 |
| --- | ---: | ---: | ---: |
| 1m green | 11,519/23,509 (49.0%) | 551/1,047 (52.6%) | 24/41 (58.5%) |
| 1m red | 5,115/10,654 (48.0%) | 108/237 (45.6%) | 3/9 (33.3%) |
| 5m green | 2,710/5,494 (49.3%) | 131/246 (53.3%) | 7/9 (77.8%) |
| 5m red | 1,998/4,169 (47.9%) | 81/162 (50.0%) | 3/5 (60.0%) |
| 10m green | 1,529/2,941 (52.0%) | 80/156 (51.3%) | 3/8 (37.5%) |
| 10m red | 1,103/2,380 (46.3%) | 41/93 (44.1%) | 4/4 (100.0%) |

The apparent 5m green D3 result is **seven favorable next closes in nine
observations**. Eight of those nine next real candles had a green body, but
none was a fourth consecutive green doji. In the later 2024–2026 portion,
only one of three next closes was favorable. The rough 95% Wilson interval
for the full-sample 7/9 frequency is 45%–94%, before allowing for serial
dependence or scanning many timeframe, color, style, and streak combinations
([NIST interval method](https://itl.nist.gov/div898/handbook/prc/section2/prc241.htm)).
No Regular 1m, 5m, or 10m green D4 with an eligible next bar occurred in this
archive. A 10m red D3's 4/4 cannot establish a 100% chance either. Selecting
the largest historical percentage from many small cells would overfit the
sample ([Bailey et al., *Notices of the AMS*](https://www.ams.org/journals/notices/201405/rnoti-p458.pdf)).

The JSON also reports next-bar color, next same-color doji, both candle styles,
all eight SPY timeframes, sample counts, rough Wilson intervals, and an
early/recent diagnostic split. The split is **not** an untouched holdout: the
whole archive was inspected for this exploratory question.

## Decision boundary

No streak length or timeframe is selected as a trading rule. The percentages
do not show an 80% chance of a profitable trade. A trade test needs a frozen
instrument, entry trigger, direction, target, stop, maximum holding time,
costs, and a rule for bars that touch target and stop before new forward data
are evaluated. Until then, D1/D2/D3 remain chart context.
