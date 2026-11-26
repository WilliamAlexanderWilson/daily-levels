# Private live equity charts

The owner chose private live access using the existing Alpaca account on
2026-11-16. GitHub Pages continues to serve the public dashboard and dated
archives. Each connected browser receives its own live data directly from
Alpaca; there is no shared public relay or order submission.

## Connect

1. Select SPY, QQQ, or NVDA and open **Connect live [symbol]** above the chart.
2. Enter the existing Alpaca API key and secret in that form, then choose
   **Connect privately**. Do not paste credentials into chat or commit them.
3. Wait for history recovery and a fresh trade. **Live IEX** means the
   connection is synchronized and its displayed trade is at most 10 seconds old.
4. Use **Disconnect** to stop. Reloading or closing the tab clears the
   connection. Range Desk does not save keys to localStorage, sessionStorage,
   URLs, logs, or its public repository.

Only `data.alpaca.markets` and `stream.data.alpaca.markets` receive the
credentials. The project’s existing local `.env` and GitHub secrets remain
separate from the website. A second active stream may exceed Alpaca's account
connection limit; close the other connection before retrying.

## What updates

- Last-trade price streams from IEX, a single exchange. This is not consolidated
  SIP coverage. The current account's IEX request succeeded and SIP request
  returned HTTP 403 in the 2026-11-16 access check.
- Candles use provider-completed one-minute OHLCV bars, then aggregate to
  1m/5m/10m/15m/20m/30m/1H/4H using the New York regular-session anchor.
  Intraminute trades update the price ticker, not a fabricated forming OHLC bar.
- Dojis and their streaks recalculate on each completed or corrected bar in
  the selected Regular or Heikin Ashi style. Corrections can add, remove, or
  recolor a prior marker and change subsequent streak counts.
- Reconnects recover missing history before resuming updates. If no minute
  event arrives, a REST recovery after three seconds confirms the boundary
  for longer intervals; genuinely empty IEX minutes are not fabricated.
- Earlier history, selected context, and the current chart viewport are
  preserved. New bars follow the latest edge only when already viewing it.
- Range levels, research percentages, and strategy gates remain batch data.
  SPY paper execution remains disabled pending explicit trading rules.

## Timing evidence and limits

The target is to draw a qualifying doji within 10 seconds of candle close.
Two direct stream samples on 2026-11-16 arrived 74ms and 120ms after close.
A real Chromium chart test then displayed a newly completed minute 0.21s
after close. These observations are not a continuous service guarantee.
The control panel reports the last observed stream-bar drawing delay and
flags delays beyond 10 seconds. Network outages, suspended browser tabs,
provider delivery, sparse IEX activity, and later corrections remain relevant.

Aggregation uses the existing verified 2026–2027 exchange calendar, including
early closes. Session calendars require maintenance for subsequent years.

Provider references:

- [Stock stream and later bar corrections](https://docs.alpaca.markets/us/docs/real-time-stock-pricing-data)
- [Authentication and connection limits](https://docs.alpaca.markets/us/docs/streaming-market-data)
- [IEX and SIP coverage](https://docs.alpaca.markets/us/docs/market-data-faq)

## Extended-hours release — November 26, 2026

SPY now defaults to **Include extended hours**. Its separately generated
`spy_extended_chart.json` and `archive/spy-extended` contain actual IEX prints
in premarket and after-hours as well as the regular session. Choose
**Regular hours · research** to use the existing archive and its historical
doji comparisons. The frozen research inputs and forward-test rules are unchanged.
Extended chart aggregation clips bins at session boundaries; the 2024–2027
half-day dates in `src/spy/chart_timeframes.py` need annual maintenance.

QQQ and NVDA can now use the same private IEX connection. Changing assets
stops the old stream and clears its credentials, price, and candle state;
connect again for the newly selected equity. Credentials remain tab-memory-only.
Live recovery replaces the covered portion of the archive, so the older
QQQ/NVDA export grid cannot leave duplicate or overlapping current-day bins.

A live read-only sample for November 24–25 returned premarket and after-hours
bars for all three symbols: SPY 27/5, QQQ 8/1, NVDA 87/5. This is a sparse
single-exchange feed, not consolidated SIP or overnight coverage. Missing
minutes and closed periods are never fabricated. BTC/ETH already stream 24/7.
XAU remains a scheduled benchmark archive: its HTTP history endpoint returns
an empty Access-Control-Allow-Origin for the Pages origin. Live XAU candle
recovery requires a supported relay/feed; no proxy or new service was deployed.

/ES remains pending a licensed CME data source. TradingView's public embed
rejected `CME_MINI:ES1!`. Databento is one supported API option, requiring
an eligible subscription and a private relay for its live API; personal data
must not be republished through the public GitHub repository. No subscription
or charge was authorized or created.

Verification for this release: 162 JavaScript tests, 182 Python tests, and
28 desktop/mobile browser checks passed. After-hours stream events and
cross-symbol isolation were exercised with deterministic feed fixtures;
real provider history verified that extended prints exist. The actual chart
library rendered successfully at desktop and mobile widths with no page
errors or horizontal overflow. A real-time equity session was not observed
on the Thanksgiving holiday; do not treat simulated arrivals as latency proof.
