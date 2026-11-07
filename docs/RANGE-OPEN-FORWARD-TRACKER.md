# Range-open forward tracker

Pre-registered: 2026-11-06
Owner: William Wilson
Version: `range-open-forward-v1`
Forward start: `2026-11-08T00:00:00Z`

## Question

When BTC, ETH, or SPY reaches a major market open near the edge of its prior
60-calendar-day range, what happens over the next 15, 30, 60, and 120 minutes?

This is a prospective descriptive study. It does not authorize a trade, place
an order, or claim that an opening session predicts direction or profitability.
The rules below are frozen before any post-cutoff outcome is observed.

## Event and range definition

1. Evaluate the seven regular opens already shown by the Dallas market clock:
   New York cash, Chicago CME U.S. index-futures reopen, London, Tokyo,
   Hong Kong, Frankfurt/Xetra, and Sydney.
2. Cash opens are modeled Monday-Friday. CME reopens Sunday-Thursday at
   5:00 p.m. America/Chicago. Version 1 does not remove exchange holidays,
   half-days, emergency closures, or daylight-saving anomalies beyond IANA
   timezone conversion. An event with no exact opening candle is not invented.
3. Build the range from completed source candles in the 60 calendar days
   strictly before the session open. The opening candle and every later candle
   are excluded from the range.
4. Require at least 90% of the expected candles across that lookback and an
   exact source candle at the session-open timestamp. Otherwise, skip creation
   and report the missing-data limitation.
5. Range position is `(opening price - range low) / (range high - range low)`.
   The lower 35% is `LOWER EDGE`, the upper 35% is `UPPER EDGE`, and the middle
   30% is `WAIT`. The 35% threshold matches the dashboard's existing explicit
   range-location assumption; it was not selected from forward outcomes.
6. Preserve every created event, including `WAIT` events. Do not hide mid-range
   opens merely because they are not directional edge observations.

## Outcomes

For every event, record raw return at 15, 30, 60, and 120 minutes from the
opening price. For edge events also record direction-aligned return:

- lower edge: positive when price rises;
- upper edge: positive when price falls.

Record maximum favorable and adverse direction-aligned excursion over the
first 120 minutes. Also record a sweep/reclaim when price trades beyond the
relevant range boundary and the 120-minute close finishes back inside it.

An event remains `PENDING` until all exact candles required for 120 minutes are
complete. Missing candles never count as flat returns or completed evidence.
Existing event range boundaries and opening prices are immutable; later runs
may only fill outcomes that were unavailable earlier.

## Evidence gate

The dashboard may show event counts immediately. It must not headline a
reaction rate until the asset has all of:

- at least 50 resolved edge events in total;
- at least 20 resolved lower-edge events; and
- at least 20 resolved upper-edge events.

Before that gate, the visible state is `COLLECTING FORWARD EVIDENCE`. Passing
the gate permits a descriptive rate, not a `buy`, `sell`, `long now`, `short
now`, `validated edge`, or profitability label. The label is revocable as new
events arrive.

The displayed 60-minute positive-direction rate is the share of resolved edge
events whose direction-aligned 60-minute return is strictly above zero. A zero
return is not counted as positive. No event is weighted more heavily because
its move was larger.

## Sources and limits

- BTC/ETH: Coinbase Exchange public 15-minute candles. This is one crypto
  venue, not a consolidated market.
- SPY: Alpaca's free IEX 5-minute bars. IEX is one U.S. exchange, not SIP; many
  overseas-session opens may have no exact SPY candle and must remain absent.
- The tracker measures the underlying asset, not options fills, leverage,
  slippage, fees, or executable strategy returns.
- Session opens can coincide. London and Frankfurt may therefore share the
  same price path; that is real overlap, not independent confirmation.

## Change control

Do not alter the cutoff, lookback, 35% edge bands, horizons, sample gate, or
outcome definitions after results appear under this version. A material change
requires a new version and a new future cutoff recorded before results are run.
