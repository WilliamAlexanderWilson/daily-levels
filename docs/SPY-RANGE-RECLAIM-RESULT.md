# SPY opening-range reclaim result

- Status: **rejected in validation; no live candidate**
- Method: `spy-or-reclaim-v1`
- Frozen protocol: `docs/SPY-RANGE-RECLAIM-PREREGISTRATION.md`
- Result artifact: `research/spy_or_reclaim_v1.json`

## Decision

Do not show a live Call, Put, Buy, or Sell label from this strategy. All four
preregistered candidates had negative expectancy in both training and the
untouched validation partition. No candidate met the validation gate, so none
was selected and the locked historical holdout was deliberately not opened.

This is a useful negative result: the product now has direct evidence that a
simple opening-range sweep, completed close back inside, and relative-volume
filter is not enough to justify a SPY trade prompt on this dataset.

## Evidence

The frozen source snapshot contains 41,857 raw 5-minute SPY bars from Alpaca
IEX, including 38,689 regular-session bars after the preregistered session
filter, covering 2024-11-08 through 2026-11-06. Its SHA-256 is
`62af3f9eba5bdca73f800e845db3208b2762ef62177efe7b6ded8fe441faf8fe`.
Results below include the frozen 8-basis-point cost stress unless marked
otherwise.

| Candidate | Validation trades | Long / short | Expectancy at 8 bps | Expectancy at 4 bps | Profit factor | Validation result |
|---|---:|---:|---:|---:|---:|---|
| 15m range, midpoint, 1.00x volume | 43 | 15 / 28 | -0.088% | -0.048% | 0.21 | Fail |
| 30m range, midpoint, 1.00x volume | 63 | 31 / 32 | -0.097% | -0.057% | 0.26 | Fail |
| 30m range, midpoint, 1.25x volume | 46 | 22 / 24 | -0.084% | -0.044% | 0.35 | Fail |
| 30m range, opposite edge, 1.25x volume | 66 | 33 / 33 | -0.105% | -0.065% | 0.34 | Fail |

Even the least-negative result lost about 0.044% per trade under the lighter
4-basis-point assumption. Long and short subsets were both negative for every
candidate. This is not a borderline sample that missed one administrative
gate; the economic result itself was negative.

## Product consequence

- The main SPY chart remains free of retrospective Call/Put arrows.
- The decision card says `WAIT` and exposes the best tested expectancy, sample
  size, and blocked promotion state.
- The scheduled chart remains batch context, not a real-time signal engine.
- The older exhaustion/options experiment stays in the collapsed research
  audit only and is not presented as a current setup.

## Data boundary

Alpaca IEX is one U.S. exchange, not the consolidated SIP market. A future
production-quality SPY study should use SIP data and must freeze a genuinely
different thesis before looking at its validation results. The failed rules in
this study must not be repeatedly tuned against the same validation partition.

## Next research step

Do not add more filters to these four rules after seeing their results. A new
study would need a new preregistration, a distinct hypothesis, fresh temporal
partitions, and the same fail-closed product gate. Until such a study clears
validation, holdout, and forward-paper requirements, the correct live state is
`WAIT`.
