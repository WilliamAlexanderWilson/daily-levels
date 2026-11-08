# SPY live research plan

Status: **not connected and not validated**

The current SPY chart is scheduled batch data. Historical exhaustion records
are retained for audit, but their Call/Put arrows are intentionally excluded
from the decision chart because the rule failed its untouched holdout test and
the outcomes were known only afterward.

## What is required for a genuinely live version

1. **A credential-safe streaming backend.** GitHub Pages cannot safely hold an
   Alpaca key. A backend must authenticate to the stock WebSocket, aggregate
   completed bars, expose only derived public state, reconnect safely, and mark
   the UI stale whenever the stream is not current.
2. **Appropriate market coverage.** Free Alpaca IEX is one exchange and is fit
   for prototyping, not a claim about the full market. A production-quality SPY
   read should use consolidated SIP coverage. If the UI names an actual option
   contract or tracks its executable premium, it also needs current OPRA bid and
   ask data rather than Black-Scholes estimates or a free indicative feed.
3. **Frozen candidate rules before results are viewed.** Volume, VWAP, opening
   range, range-edge location, candle-close confirmation, invalidation, target,
   trading hours, and transaction-cost assumptions must be specified before a
   new validation window is inspected.
4. **A new evidence ladder.** Candidate rules must pass chronological training,
   validation, untouched holdout, walk-forward regime checks, cost/slippage
   stress, and a preregistered forward paper record. The existing exhaustion
   rule cannot be promoted because it lost across the untouched half.
5. **Fail-closed presentation.** Until every gate passes, the live UI may show
   `DATA STALE`, `WAIT`, or `RESEARCH WATCH`; it must not show `Call`, `Put`,
   `Buy`, `Sell`, or `proven`. A later validated candidate may earn
   `PAPER-ELIGIBLE`, with entry, invalidation, target, data timestamp, evidence
   version, and performance limits visible together.

## Proposed implementation sequence

1. Add the secure SPY stock-stream service and live/stale heartbeat.
2. Reconcile completed live bars against the provider's historical bars.
3. Preregister a small set of range/volume candidates and their exact gates.
4. Run production-shaped historical and walk-forward research without changing
   rules after seeing the untouched results.
5. Forward-paper the frozen winner, if any. If no candidate passes, keep `WAIT`.
6. Only then connect the eligible state to the paper tracker. Real orders remain
   out of scope.

The objective is a more disciplined decision process, not a promise of high
accuracy or profitability. A strategy that does not clear the gates should
remain absent from the decision UI.
