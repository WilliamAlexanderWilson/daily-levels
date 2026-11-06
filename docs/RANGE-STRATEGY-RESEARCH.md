# Range strategy research record

Date: 2026-11-06  
Owner: William Wilson  
Scope: BTC 4-hour range-rejection research for Range Desk

## Decision

No tested range definition is currently approved as a validated trading edge.
The dashboard must remain a research and patience tool, not an automatic
buy/sell service.

The validation-period leader was the 10%–20% definition, but it still had
negative expectancy. The 4–8 ATR definition performed strongly in the final
holdout, but performed poorly in validation. Selecting it because the newest
period looks good would use the holdout for model selection and invalidate the
test.

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
- Training: first 60%.
- Validation/model selection: next 20%.
- Untouched holdout: final 20%.

Kraken's public futures chart endpoint supplies bounded historical candles.
The spot OHLC endpoint used elsewhere in the site is limited to its latest 720
candles, which is too little for this question. The live chart remains Kraken
spot; the Range Lab clearly labels its futures research source.

## Current results

| Definition | Validation trades | Validation expectancy | Holdout trades | Holdout expectancy | Holdout profit factor |
|---|---:|---:|---:|---:|---:|
| $2k–$4k | 0 | — | 2 | +1.1763% | — |
| $5k–$10k | 7 | -1.2495% | 18 | -0.1949% | 0.867 |
| 5%–10% | 19 | -1.2719% | 16 | -0.1580% | 0.846 |
| 10%–20% | 17 | -0.1425% | 18 | -0.0571% | 0.970 |
| 4–8 ATR | 14 | -1.7219% | 15 | +1.2894% | 2.615 |
| Structure | 27 | -0.6759% | 28 | -0.1147% | 0.930 |

The positive holdout values with two or fifteen trades are not enough to
override failed validation. The configured pass gate requires positive
validation before a candidate may be selected, followed by at least 30
holdout trades, positive holdout expectancy, and profit factor above 1.

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

## Tomorrow's plan

1. Reconcile the futures candles against Kraken spot over their overlapping
   720-candle window and report missing bars and price differences.
2. Freeze a small, pre-registered second-round test: midpoint exit versus a
   half-at-midpoint/half-at-opposite-edge runner, without adding parameters
   after seeing results.
3. Add walk-forward windows so the dashboard shows whether an edge is stable
   across regimes instead of relying on one split.
4. Add long/short breakdowns, cost sensitivity, drawdown duration, and a
   minimum-sample warning.
5. Forward-paper-track any candidate that passes, with no real orders, before
   considering it a live setup aid.
6. Only after BTC survives that process, apply the same frozen methodology to
   ETH. SPY requires a separate market-hours and gap-aware design.

The next objective is not to force a profitable-looking answer. It is to find
whether a repeatable edge survives realistic costs and genuinely unseen data.

