# Decision Lock

Method version: `decision-lock-v1`

Decision Lock connects the live three-condition range checklist to the paper
risk ticket. It is a consistency gate, not a prediction or trading signal.

An entry becomes **paper-eligible** only when all five statements are true:

1. The current price location, boundary test, and latest completed-candle
   confirmation are all ready, and the ticket uses a fresh live entry. Manual,
   historical, stale, and materially drifted entries can be inspected but
   cannot be saved as paper-eligible positions.
2. The selected direction matches the confirmed edge: long at confirmed
   support or short at confirmed resistance.
3. The stop is beyond the mapped invalidation boundary.
4. The first target stays at or before the opposite mapped boundary.
5. Planned reward-to-risk meets the user's explicit minimum-R rule.

The paper ticket is capped at 2% planned account risk. This is a project safety
ceiling, not evidence that 2% is safe for a particular person. Leverage changes
required margin and magnifies outcomes; it does not improve the setup. The
existing liquidation check still rejects a plan when estimated liquidation
would occur before the stop.

Primary risk references:

- CME Group, [Proper Position Size](https://www.cmegroup.com/education/courses/trade-and-risk-management/proper-position-size)
- CFTC, [Understand the Risks of Virtual Currency Trading](https://www.cftc.gov/LearnAndProtect/AdvisoriesAndArticles/understand_risks_of_virtual_currency.html)
- FINRA Regulatory Notice 16-19, [stop-order execution risk](https://www.finra.org/sites/default/files/notice_other_file_ref/Regulatory-Notice-16-19.pdf)

These sources support planning account risk, sizing from a logical stop,
recognizing leverage amplification, and disclosing that a stop price is not a
guaranteed fill. They do not validate the dashboard's range method or imply
profitability.
