# Range strategy research record

Date: 2026-11-06
Owner: William Wilson
Scope: BTC 4-hour range-rejection research for Range Desk

## Decision

No tested range definition is currently approved as a validated trading edge.
The dashboard must remain a research and patience tool, not an automatic
buy/sell service.

The validation-period leader was the structure definition, but it still had
negative expectancy. No definition was positive in validation, so none was
eligible to be selected for the locked historical holdout.

## What “range” means in this experiment

A range is the prior rolling window's high and low, accepted only when:

- both edges have at least two historical tests;
- closing-price drift is no more than 35% of the range width;
- its width matches the selected definition;
- every input candle predates the signal candle.

The compared definitions are $2,000–$4,000, $5,000–$10,000, 5%–10%,
10%–20%, 4–8 ATR, and structure-only. ATR means average true range, a way to
scale the range to current volatility. Fixed dollars are included because they
were requested, but percentage and ATR ranges are more comparable across BTC
price regimes.

## Mechanical trade rule tested

1. Define the range from completed prior candles only.
2. Require the signal candle to test an outer 10% edge and close back inside.
3. Enter at the next 4-hour candle's open.
4. Exit at the midpoint, at a stop 0.35 ATR beyond the boundary, or after the
   maximum holding window.
5. Charge 0.20% fee plus 0.05% slippage on each side.
6. If stop and target are both touched in one candle, count the stop first.

This is intentionally conservative and does not assume a perfect fill at the
wick. It tests rejection-to-midpoint, not a guaranteed full trip from one edge
to the other.

## Data and split

- Instrument: Kraken `PF_XBTUSD` perpetual futures.
- Timeframe: 4 hours.
- Sample: 10,133 completed candles, 2022-03-23 through 2026-11-06.
- Training: history before 2024-01-01.
- Validation/model selection: 2024-01-01 through 2024-12-31.
- Locked historical holdout: 2025-01-01 through 2026-11-06.

These calendar boundaries are permanent across scheduled refreshes. Each
partition is replayed separately, with prior candles available only as range
context and position state reset at the boundary. Because the historical
holdout was inspected while building this first version, it is not presented
as pristine prospective evidence; genuinely new evidence begins with forward
paper tracking after the strategy definitions are frozen.

Kraken's public futures chart endpoint supplies bounded historical candles.
The spot OHLC endpoint used elsewhere in the site is limited to its latest 720
candles, which is too little for this question. The live chart remains Kraken
spot; the Range Lab clearly labels its futures research source.

## Current results

| Definition | Validation trades | Validation expectancy | Holdout trades | Holdout expectancy | Holdout profit factor |
|---|---:|---:|---:|---:|---:|
| $2k–$4k | 0 | — | 2 | +1.1763% | ∞ (no losing trades; sample far too small) |
| $5k–$10k | 15 | -2.0297% | 25 | -0.4916% | 0.677 |
| 5%–10% | 3 | -2.1872% | 35 | -0.7624% | 0.440 |
| 10%–20% | 23 | -2.0787% | 34 | -0.2587% | 0.863 |
| 4–8 ATR | 16 | -1.4976% | 29 | -0.1643% | 0.880 |
| Structure | 29 | -0.8868% | 54 | -0.4967% | 0.714 |

The positive holdout value with only two trades is not enough to override
missing validation evidence. The configured pass gate requires positive
validation before a candidate may be selected, followed by at least 30
holdout trades, positive holdout expectancy, and profit factor above 1.

## Futures-versus-spot reconciliation

Completed 2026-11-06 over the bounded recent Kraken spot window used by the
visible chart:

- 720 completed 4-hour timestamps aligned;
- zero timestamps missing from either market;
- futures close averaged 0.0072% above spot;
- median absolute close difference was 0.0104%, p95 was 0.0340%, and the
  maximum was 0.0841%;
- candle direction agreed 98.33% of the time; and
- the futures and spot high-low envelopes overlapped on all compared bars.

The intrabar extremes were less interchangeable than closes: p95 absolute
high difference was 0.1328% and p95 absolute low difference was 0.1518%, with
maximums of 1.0072% and 0.6870%. The conclusion is therefore narrow: recent
spot candles are close enough to provide visual context for the futures
research, but they are not a substitute for futures fills, stops, or backtest
inputs. This comparison is data-quality evidence, not profitability evidence.

Kraken's spot documentation says the endpoint returns up to 720 recent entries
and always includes the forming candle. The live 2026-11-06 response contained
721 rows including that forming candle, so the implementation does not hardcode
an assumed completed-row count; it compares the completed timestamps actually
returned. Sources: <https://docs.kraken.com/api-reference/market-data/get-ohlc-data>
and <https://docs.kraken.com/api/docs/futures-api/charts/candles>.

## Research evidence

- Kraken describes range trading as buying near support and selling near
  resistance, while warning that ranges can break quickly and require explicit
  risk limits: <https://www.kraken.com/gb/learn/day-trading-strategies>
- Kraken's public futures candle endpoint and supported 4-hour resolution:
  <https://docs.kraken.com/api/docs/futures-api/charts/candles>
- Bailey et al. explain why repeated strategy optimization can manufacture an
  impressive backtest and why out-of-sample testing matters:
  <https://academic.oup.com/jrssig/article/18/6/22/7038278>
- Harvey and Liu show that multiple testing raises the evidence threshold for
  claimed financial discoveries:
  <https://academic.oup.com/rfs/article-abstract/33/5/2134/5739455>
- Corbet et al. study moving-average and trading-range rules in Bitcoin rather
  than assuming support/resistance is automatically profitable:
  <https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3454216>
- Zakamulin shows why transaction costs materially alter mean-reversion
  strategy design: <https://arxiv.org/abs/1103.4934>

## Pre-registered exit comparison

Frozen 2026-11-06 before the runner results were computed. Version:
`range-exit-runner-v1`.

The baseline remains unchanged: close 100% of the position at the range
midpoint, the original stop, or the existing maximum holding window.

The single comparison variant is:

1. Enter from the same completed-candle rejection at the same next-bar open.
2. Close 50% at the range midpoint.
3. Close the remaining 50% at the opposite range boundary.
4. Keep the original stop 0.35 ATR beyond the entry boundary for all remaining
   size; do not move it to breakeven after the midpoint fills.
5. Keep the same maximum holding window. Any unclosed size exits at that final
   bar's close.
6. Charge the same 0.20% fee and 0.05% slippage per side, weighted by the size
   of each leg.
7. If a stop and an unfilled target occur in the same candle, resolve the stop
   first for all size still open. If both favorable targets occur without the
   stop, both may fill because price necessarily crossed the midpoint on the
   way to the opposite edge.
8. Apply this one frozen variant to all six existing range definitions and the
   same train, validation, and historical holdout partitions. Do not add a
   breakeven rule, trailing stop, alternate split, or new holding period after
   seeing the results.

This is an exploratory historical sensitivity test, not a new untouched
holdout: the existing 2025-2026 holdout prices were already inspected while
building the first Range Lab. Even a favorable runner result cannot earn a
validated or proven label without genuinely later forward evidence.

### Frozen runner result

Computed only after commit `6a23e60` recorded the rules above.

| Definition | Runner validation expectancy | Runner holdout expectancy | Runner holdout PF | Runner holdout trades |
|---|---:|---:|---:|---:|
| $2k–$4k | — | -0.3646% | 0.000 | 1 |
| $5k–$10k | -2.4321% | +0.2926% | 1.192 | 19 |
| 5%–10% | -2.1872% | -0.8932% | 0.375 | 30 |
| 10%–20% | -2.6775% | +1.0326% | 1.620 | 27 |
| 4–8 ATR | -1.7990% | -0.6286% | 0.587 | 24 |
| Structure | -0.6204% | +0.5305% | 1.328 | 41 |

The runner improved the old holdout for $5k–$10k, 10%–20%, and structure
ranges, but **every definition remained negative in validation** (or had no
validation trades). It therefore did not clear the pre-existing validation
gate and no runner candidate is eligible for promotion. The positive old
holdout cells are hypotheses for genuinely forward evidence, not trade calls.

## Tomorrow's plan

1. ~~Reconcile the futures candles against Kraken spot over their overlapping
   recent window and report missing bars and price differences.~~ Completed
   2026-11-06; results are recorded above and emitted in the live artifact.
2. ~~Freeze a small, pre-registered second-round test: midpoint exit versus a
   half-at-midpoint/half-at-opposite-edge runner, without adding parameters
   after seeing results.~~ Completed 2026-11-06; no runner cleared validation.
3. Add walk-forward windows so the dashboard shows whether an edge is stable
   across regimes instead of relying on one split.
4. Add long/short breakdowns, cost sensitivity, drawdown duration, and a
   minimum-sample warning.
5. Forward-paper-track any candidate that passes, with no real orders, before
   considering it a live setup aid.
6. Only after BTC survives that process, apply the same frozen methodology to
   ETH. SPY requires a separate market-hours and gap-aware design.

## Forward paper record

Implemented after the initial research review. The six original definitions,
cost assumptions, entry rule, stop, midpoint target, and holding windows are
frozen as `range-rejection-v1` from `2026-11-06 04:00 UTC`. Every scheduled
Range Lab refresh now incorporates genuinely later evidence deterministically:

- each candidate is tracked separately; results are not pooled;
- an edge rejection on the newest completed candle is marked pending until the
  next 4-hour open exists;
- a filled paper observation remains open until target, stop, or its complete
  holding window is observed;
- only closed observations enter forward expectancy, profit factor, and
  drawdown; and
- no order is sent and no candidate is relabeled validated by this feature.

Because no candidate passed the initial validation gate, this is an
observation record, not a deployment of a selected strategy. A future label
change requires enough prospective observations and a separately documented
evidence threshold; it must not be inferred from one favorable result.

The next objective is not to force a profitable-looking answer. It is to find
whether a repeatable edge survives realistic costs and genuinely unseen data.
