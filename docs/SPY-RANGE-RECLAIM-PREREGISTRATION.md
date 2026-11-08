# SPY opening-range reclaim preregistration

Method version: `spy-or-reclaim-v1`

Frozen before computing this method's results on 2026-11-08. This is an
underlying-SPY research protocol, not an options recommendation. Alpaca IEX is
one exchange, so any surviving result remains a prototype until reconciled
against consolidated SIP data.

## Data and partitions

- Input: regular-session, raw, 5-minute SPY OHLCV bars from Alpaca IEX.
- Train: data before 2025-11-08.
- Validation: 2025-11-08 through 2026-05-07 inclusive.
- Locked historical holdout: 2026-05-08 onward.
- The holdout is inspected once for this version and can never be reused as an
  untouched selection set.

## Four frozen candidates

| Key | Opening range | Target | Signal-volume requirement |
|---|---:|---|---:|
| `or15-mid-rvol100` | first 15 minutes | opening-range midpoint | at least 1.00x prior-20-bar median |
| `or30-mid-rvol100` | first 30 minutes | opening-range midpoint | at least 1.00x prior-20-bar median |
| `or30-mid-rvol125` | first 30 minutes | opening-range midpoint | at least 1.25x prior-20-bar median |
| `or30-opposite-rvol125` | first 30 minutes | opposite opening-range edge | at least 1.25x prior-20-bar median |

No parameters may be added or changed after results are viewed under this
method version.

## Frozen event and execution rules

1. Use completed regular-session bars only. The signal window is 10:00 AM
   through 2:30 PM New York time.
2. Long observation: a completed bar trades below the opening-range low and
   closes back above it. Short observation: it trades above the opening-range
   high and closes back below it.
3. Signal-bar volume must meet the candidate's threshold relative to the
   median volume of the prior 20 regular-session bars. No future bar is used.
4. Enter at the next 5-minute bar's open. Allow at most one trade per day.
5. Long stop: signal low minus 0.05% of entry. Short stop: signal high plus
   0.05% of entry.
6. Target is fixed by the candidate table. Reject geometry with a target on
   the wrong side of entry or planned reward-to-risk below 1.0.
7. Exit at stop, target, or the 3:45 PM bar close. If stop and target are both
   touched within one bar, count the stop first.
8. Primary return subtracts four basis points round trip. Cost stress subtracts
   eight basis points round trip. No option premium is modeled.

## Frozen selection and promotion gates

Train is descriptive only. A candidate may be selected on validation only if:

- at least 30 resolved validation trades;
- at least 10 long and 10 short validation trades;
- positive validation expectancy at both four and eight basis points;
- profit factor at eight basis points is at least 1.20;
- maximum validation drawdown is at most 8%; and
- long and short validation expectancy are each non-negative at eight basis
  points.

If multiple candidates pass, select the highest eight-basis-point validation
expectancy; ties use the simpler/earlier table row. If none pass, select none
and do not inspect the holdout as a rescue mechanism.

A selected candidate may earn `HISTORICAL GATE PASSED` only if its locked
holdout independently has at least 30 trades, at least 10 in both directions,
positive eight-basis-point expectancy, profit factor at least 1.10, maximum
drawdown at most 10%, and non-negative expectancy in each direction and each
chronological half.

Historical passage still does not create a live call. A frozen candidate must
then record at least 50 forward paper trades, with at least 20 in each
direction, positive eight-basis-point expectancy, profit factor at least 1.10,
and maximum drawdown at most 10%. Until then the UI remains `WAIT` or
`RESEARCH WATCH`.
