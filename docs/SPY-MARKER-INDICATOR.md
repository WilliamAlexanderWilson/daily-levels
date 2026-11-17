# SPY marker-run indicator and frozen forward test

The panel below the chart counts successive same-color completed **doji markers**.
Ordinary candles do not reset it; an opposite-color doji does. It is separate
from the existing D1/D2 adjacent-candle labels. No trade signal is emitted.

The panel shows the latest loaded doji by default. Selecting a candle shows the
run at or before that candle. It displays Regular/HA style, marker time, first-to-last
wall-clock span, observed session crossings, and flat-marker count. Flat dojis
(open equals close) retain the chart's green coloring, explicitly disclosed.
If the first loaded run has no preceding opposite marker, it is labeled “at
least” and exact-run statistics are withheld until older history establishes
the boundary. Provider corrections recompute the run with the existing dojis.

Historical comparisons use the same chart style and exact run position (6+
pools later positions). They show next-doji color, its sample count, and the
baseline after any same-color marker. Baseline includes the selected subset.
Real-price movement three candles later is separate, uses real closes, excludes
session/missing-bar crossings, and has its own denominator. Historical data may
postdate a selected candle. No causal, confidence-of-success, or profitability
claim is made.

The compact `site/data/spy_marker_context.json` is loaded only for SPY. A failed
request leaves run counting available and offers retry. Scheduled exports
replace it atomically only after successful generation. A failed export keeps
the dated prior report and marks the workflow failed after unaffected exports.

## Frozen prospective protocol

`research/spy-marker-forward-v1.json` is frozen before the evaluation window:

- Start: **November 17, 2026, 8:30 AM Dallas time** (14:30 UTC).
- Regular 5m; body ≤10% of range; exactly the fifth consecutive green marker.
- Ordinary candles ignored; sequences may cross sessions and may begin before
  the window. Green includes flat dojis, matching the tested chart definition.
- Only signal candles closing after the start are evaluated. The next completed
  doji resolves the primary outcome; it has no artificial deadline. A missing
  next marker stays pending, never a loss. Flat next markers are recorded.
- Baseline: next-doji green rate after any green marker whose signal is in the
  same forward window. It includes five-marker events and is not an independent
  control group.
- Secondary outcome: actual close higher three contiguous, same-session candles
  later. This is not a target/stop trade result.
- Review waits for **both February 17, 2027 and 100 resolved pattern events**.
  This is an operational checkpoint, not a power calculation or proof of an
  advantage. If the count is not met, keep collecting without retuning v1.
- Interim counts remain descriptive. A substantive protocol change needs a new
  version and a new future window; the v1 file has a test-checked digest.

The exporter reconstructs new-window events from the published IEX archive and
stores their timestamps, flat counts, outcomes, pending status, and aggregate
baseline in the report. Collection runs with the existing scheduled batch
workflow; it does not depend on a browser staying open or on private keys in
client storage. This is prospective **batch research**, not real-time execution
measurement. Vendor corrections can revise events/results; git data commits
preserve the published revisions. Before interpreting results, audit those
revisions and account for dependent/overlapping events and multiple research
comparisons. Neither the calendar checkpoint nor a favorable percentage validates
a strategy. Entry, target, stop, holding rules, and costs remain undefined.

## Reproduce and verify

```sh
node scripts/export-spy-marker-context.js > /tmp/spy_marker_context.json
node --test tests/test_marker_runs.js
```

No new subscription, trading API, alerts, or order submission is introduced.
